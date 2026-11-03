/**
 * The related records for a sample dry run, read from a disposable loopback
 * database instead of a hand-written related.json.
 *
 * Two locks keep this from ever touching production, or touching anything:
 *
 *   1. assertLoopbackDatabase refuses any DATABASE_URL (or DIRECT_URL) that
 *      does not point at this machine, the same rule as seedUiCheck.ts and
 *      the integration test runner, and refuses when DATABASE_URL is not set
 *      at all rather than letting Prisma find one in a .env file.
 *   2. Every read runs inside a READ ONLY transaction, so PostgreSQL itself
 *      rejects a write even if one were ever added here by mistake.
 *
 * The loader only ever calls findMany. The rows are turned into the same
 * RelatedRecords a related.json produces, and the same pure path decides.
 */
import { SupplierType, TicketSource, type Prisma, type PrismaClient } from '@prisma/client';
import { businessDayOf } from '../../lib/businessDay.js';
import type { CandidateLoad } from '../../modules/matching/haulMatch.js';
import { poKey } from '../../modules/matching/poKey.js';
import { resolveHaulTolerances, resolveTolerances } from '../../modules/matching/tolerances.js';
import type {
  RelatedInvoiceLine,
  RelatedOrder,
  RelatedRate,
  RelatedRecords,
  RelatedSupplier,
  RelatedTicket,
} from '../../modules/matching/dryRunDecision.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function assertLoopbackUrl(name: string, raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid database URL`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `Refusing to read a non-loopback database (${name} host: ${url.hostname}). ` +
        'The sample dry run only ever reads a disposable database on this machine.'
    );
  }
  // PostgreSQL URLs can name the real host in a query parameter, which would
  // otherwise slip past a check of the URL's own host.
  for (const key of ['host', 'hostaddr']) {
    const value = url.searchParams.get(key);
    if (value !== null && !LOOPBACK_HOSTS.has(value)) {
      throw new Error(`Refusing to read a non-loopback database (${name} ${key}=${value}).`);
    }
  }
}

/**
 * The database URL to read, once it is shown to be on this machine.
 *
 * DATABASE_URL must be set in the environment of the command itself: a URL
 * Prisma would otherwise pick up from a .env file is exactly the one this
 * script must never use, because that file is where production credentials
 * live.
 */
export function assertLoopbackDatabase(env: Record<string, string | undefined>): string {
  const raw = env.DATABASE_URL;
  if (!raw || !raw.trim()) {
    throw new Error(
      'DATABASE_URL is not set. Pass a loopback database on the command line, e.g. ' +
        'DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/disposable npm run samples:dry-run -- --db'
    );
  }
  assertLoopbackUrl('DATABASE_URL', raw);
  if (env.DIRECT_URL && env.DIRECT_URL.trim()) assertLoopbackUrl('DIRECT_URL', env.DIRECT_URL);
  return raw;
}

/** The handful of models this loader reads. Only findMany is ever called on them. */
export type ReadOnlyDb = Pick<
  Prisma.TransactionClient,
  | 'supplier' | 'supplierProductAlias' | 'order' | 'ticket' | 'negotiatedRate' | 'invoiceLineItem' | 'systemSetting'
  | 'dispatchLoad' | 'matchResult'
>;

/** Runs `read` inside a transaction PostgreSQL will not let write. */
export async function inReadOnlyTransaction<T>(client: PrismaClient, read: (db: ReadOnlyDb) => Promise<T>): Promise<T> {
  return client.$transaction(
    async (tx) => {
      // Must be the first statement of the transaction to take effect.
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return read(tx);
    },
    { timeout: 120_000, maxWait: 10_000 }
  );
}

function toNumber(value: Prisma.Decimal | number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Same as poNumberConditions in matching.service.ts: the exact text, or anything holding the six digits. */
function poConditions(poNumber: string): Array<{ poNumber: string | { contains: string } }> {
  const conditions: Array<{ poNumber: string | { contains: string } }> = [{ poNumber }];
  const key = poKey(poNumber);
  if (key) conditions.push({ poNumber: { contains: key.suffix } });
  return conditions;
}

/** Every supplier, so a printed name can be resolved the way production resolves it. */
export async function loadSuppliers(db: ReadOnlyDb): Promise<RelatedSupplier[]> {
  const rows = await db.supplier.findMany({ select: { id: true, name: true, type: true, active: true } });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type === SupplierType.TRUCKING_COMPANY ? SupplierType.TRUCKING_COMPANY : SupplierType.SUPPLIER,
    active: row.active,
  }));
}

export interface RecordsRequest {
  poNumbers: string[];
  /** The supplier and invoice date of each sample, for the no-PO route. */
  supplierDates: Array<{ supplierId: string; date: Date | null }>;
  /**
   * A trucking company's samples: the carrier and each day its lines say a
   * haul ran (or the invoice date), for the dispatch loads they may bill.
   */
  haulDates?: Array<{ carrierSupplierId: string; date: Date }>;
}

/** Same as CANDIDATE_LOAD_SELECT in matching.service.ts: what the haul matcher reads of a load. */
const LOAD_SELECT = {
  id: true,
  documentId: true,
  sequence: true,
  carrierSupplierId: true,
  tripRef: true,
  rate: true,
  rateUnit: true,
  quantity: true,
  ticketNumber: true,
  claimedByLineItemId: true,
  createdAt: true,
  claimedByLineItem: { select: { lineNumber: true, invoice: { select: { invoiceNumber: true } } } },
  delivery: { select: { completedAt: true } },
  document: {
    select: {
      documentNumber: true,
      poNumber: true,
      deliveryDate: true,
      lines: {
        select: {
          id: true,
          poNumber: true,
          tickets: { select: { ticketNumber: true }, where: { ticketNumber: { not: null } }, take: 50 },
        },
        orderBy: [{ lineNumber: 'asc' }, { createdAt: 'asc' }],
        take: 50,
      },
    },
  },
} as const satisfies Prisma.DispatchLoadSelect;

type LoadRow = Prisma.DispatchLoadGetPayload<{ select: typeof LOAD_SELECT }>;

/**
 * Same as haulDateOf in matching.service.ts: the order's delivery date, else
 * the yard's day the stop was done, else the yard's day the load was recorded.
 */
function haulDateOf(row: LoadRow): Date {
  if (row.document.deliveryDate) return row.document.deliveryDate;
  const instant = row.delivery?.completedAt ?? row.createdAt;
  return new Date(`${businessDayOf(instant)}T00:00:00.000Z`);
}

/** Same as toCandidateLoad in matching.service.ts. */
function toCandidateLoad(row: LoadRow): CandidateLoad {
  return {
    id: row.id,
    documentId: row.documentId,
    sequence: row.sequence,
    carrierSupplierId: row.carrierSupplierId,
    tripRef: row.tripRef,
    rate: row.rate === null ? null : row.rate.toString(),
    rateUnit: row.rateUnit,
    quantity: row.quantity === null ? null : row.quantity.toString(),
    claimedByLineItemId: row.claimedByLineItemId,
    documentNumber: row.document.documentNumber,
    haulDate: haulDateOf(row),
    ticketNumber: row.ticketNumber,
    poNumbers: [
      ...new Set([row.document.poNumber, ...row.document.lines.map((line) => line.poNumber)].filter((po): po is string => Boolean(po))),
    ],
    orderTicketNumbers: row.document.lines.flatMap((line) =>
      line.tickets.flatMap((ticket) => (ticket.ticketNumber ? [ticket.ticketNumber] : []))
    ),
    orderLineId: row.document.lines[0]?.id ?? null,
    claim: row.claimedByLineItem
      ? { invoiceNumber: row.claimedByLineItem.invoice.invoiceNumber, lineNumber: row.claimedByLineItem.lineNumber }
      : null,
  };
}

/**
 * The carriers' dispatch loads that could be what the samples' lines bill,
 * and the unsettled lines elsewhere whose verdicts count any of them. Same
 * net as loadHaulCandidates in matching.service.ts: a day wider on each side
 * than the matcher's window, by each of the three dates a haul day comes from.
 */
async function loadHauls(
  db: ReadOnlyDb,
  haulDates: NonNullable<RecordsRequest['haulDates']>,
  windowDays: number
): Promise<{ loads: CandidateLoad[]; competing: RelatedInvoiceLine[] }> {
  if (haulDates.length === 0) return { loads: [], competing: [] };
  const spread = (windowDays + 1) * 86_400_000;
  const where: Prisma.DispatchLoadWhereInput[] = haulDates.map(({ carrierSupplierId, date }) => {
    const range = { gte: new Date(date.getTime() - spread), lte: new Date(date.getTime() + spread) };
    return {
      carrierSupplierId,
      OR: [{ document: { deliveryDate: range } }, { delivery: { completedAt: range } }, { createdAt: range }],
    };
  });
  const rows = await db.dispatchLoad.findMany({ where: { OR: where }, select: LOAD_SELECT, orderBy: { createdAt: 'asc' }, take: 2_000 });
  const ids = rows.map((row) => row.id);
  const verdicts =
    ids.length === 0
      ? []
      : await db.matchResult.findMany({
          where: { invoiceLineId: { not: null }, resolution: null, loadIds: { hasSome: ids } },
          select: {
            invoiceLineId: true,
            loadIds: true,
            invoiceLine: {
              select: { lineNumber: true, poNumber: true, invoice: { select: { invoiceNumber: true, invoiceDate: true, supplierId: true } } },
            },
          },
          take: 500,
        });
  return {
    loads: rows.map(toCandidateLoad),
    competing: verdicts.flatMap((verdict) =>
      verdict.invoiceLineId && verdict.invoiceLine
        ? [
            {
              invoiceLineId: verdict.invoiceLineId,
              invoiceNumber: verdict.invoiceLine.invoice.invoiceNumber,
              lineNumber: verdict.invoiceLine.lineNumber,
              invoiceDate: verdict.invoiceLine.invoice.invoiceDate,
              poNumber: verdict.invoiceLine.poNumber,
              supplierId: verdict.invoiceLine.invoice.supplierId,
              loadIds: verdict.loadIds,
            },
          ]
        : []
    ),
  };
}

/**
 * The rows the engine could be shown for these samples. Deliberately a wide
 * net: the pure selection in dryRunDecision.ts narrows it per line exactly as
 * matchInvoiceLineById's own queries would.
 */
export async function loadRelatedRecordsFromDb(
  db: ReadOnlyDb,
  suppliers: RelatedSupplier[],
  request: RecordsRequest
): Promise<RelatedRecords> {
  const settings = await db.systemSetting.findMany({
    where: { key: { startsWith: 'match.' } },
    select: { key: true, value: true },
  });
  const tolerances = resolveTolerances(settings);
  const haulTolerances = resolveHaulTolerances(settings);
  const windowMs = tolerances.dateWindowDays * 86_400_000;

  const poNumbers = [...new Set(request.poNumbers.filter((po) => po.trim() !== ''))];
  const supplierIds = [...new Set(request.supplierDates.map((entry) => entry.supplierId))];
  const byPo = poNumbers.flatMap(poConditions);

  const orderWhere: Prisma.OrderWhereInput[] = [...byPo];
  for (const { supplierId, date } of request.supplierDates) {
    if (!date) continue;
    const from = new Date(date.getTime() - windowMs);
    const to = new Date(date.getTime() + windowMs);
    orderWhere.push({ supplierId, orderDate: { gte: from, lte: to } });
    orderWhere.push({ supplierId, orderDate: null, deliveryDate: { gte: from, lte: to } });
  }

  const ticketSelect = {
    id: true,
    ticketNumber: true,
    poNumber: true,
    quantity: true,
    unit: true,
    material: true,
    supplierId: true,
    source: true,
    duplicateOfTicketId: true,
    ticketDate: true,
    claim: {
      select: {
        invoiceLineId: true,
        claimedAt: true,
        claimedBy: { select: { name: true } },
        invoiceLine: { select: { lineNumber: true, invoice: { select: { invoiceNumber: true } } } },
      },
    },
  } as const satisfies Prisma.TicketSelect;

  const [orderRows, aliasRows, ticketRows, rateRows, lineRows] = await Promise.all([
    orderWhere.length === 0
      ? Promise.resolve([])
      : db.order.findMany({
          where: { OR: orderWhere },
          select: {
            id: true,
            poNumber: true,
            product: true,
            quantity: true,
            unit: true,
            supplierId: true,
            orderDate: true,
            deliveryDate: true,
            spruceItemNumber: true,
            document: { select: { documentNumber: true, flags: true } },
          },
          take: 2_000,
        }),
    supplierIds.length === 0
      ? Promise.resolve([])
      : db.supplierProductAlias.findMany({
          where: { supplierId: { in: supplierIds } },
          select: { supplierId: true, aliasText: true, productName: true },
        }),
    byPo.length === 0
      ? Promise.resolve([])
      : db.ticket.findMany({ where: { OR: byPo }, select: ticketSelect, take: 2_000 }),
    supplierIds.length === 0
      ? Promise.resolve([])
      : db.negotiatedRate.findMany({
          where: { supplierId: { in: supplierIds } },
          select: {
            supplierId: true,
            productName: true,
            rate: true,
            unit: true,
            effectiveFrom: true,
            effectiveTo: true,
            spruceItemCode: true,
            supplierItemCode: true,
          },
        }),
    byPo.length === 0
      ? Promise.resolve([])
      : db.invoiceLineItem.findMany({
          where: {
            AND: [{ OR: byPo }, { OR: [{ matchResult: null }, { matchResult: { resolution: null } }] }],
          },
          select: {
            id: true,
            poNumber: true,
            lineNumber: true,
            invoice: { select: { invoiceNumber: true, invoiceDate: true, supplierId: true } },
          },
          take: 500,
        }),
  ]);

  // The other copies of these loads, wherever their PO points.
  const loaded = new Set(ticketRows.map((row) => row.id));
  const roots = [...new Set(ticketRows.map((row) => row.duplicateOfTicketId ?? row.id))];
  const twinRows =
    ticketRows.length === 0
      ? []
      : await db.ticket.findMany({
          where: { id: { notIn: [...loaded] }, OR: [{ id: { in: roots } }, { duplicateOfTicketId: { in: roots } }] },
          select: ticketSelect,
          take: 500,
        });

  const orders: RelatedOrder[] = orderRows.map((row) => ({
    id: row.id,
    orderNumber: row.document?.documentNumber ?? null,
    poNumber: row.poNumber,
    product: row.product,
    quantity: toNumber(row.quantity),
    unit: row.unit,
    supplierId: row.supplierId,
    orderDate: row.orderDate,
    deliveryDate: row.deliveryDate,
    spruceItemNumber: row.spruceItemNumber,
    quote: row.document?.flags.includes('QUOTE') ?? false,
  }));

  const tickets: RelatedTicket[] = [...ticketRows, ...twinRows].map((row) => ({
    id: row.id,
    ticketNumber: row.ticketNumber,
    poNumber: row.poNumber,
    quantity: toNumber(row.quantity),
    unit: row.unit,
    material: row.material,
    supplierId: row.supplierId,
    source: row.source,
    duplicateOfTicketId: row.duplicateOfTicketId,
    emailedBySupplier: row.source === TicketSource.EMAIL,
    ticketDate: row.ticketDate,
    claim: row.claim
      ? {
          invoiceLineId: row.claim.invoiceLineId,
          invoiceNumber: row.claim.invoiceLine.invoice.invoiceNumber,
          lineNumber: row.claim.invoiceLine.lineNumber,
          claimedByName: row.claim.claimedBy?.name ?? null,
          claimedAt: row.claim.claimedAt,
        }
      : null,
  }));

  const rates: RelatedRate[] = rateRows.flatMap((row) => {
    const rate = toNumber(row.rate);
    return rate === null
      ? []
      : [
          {
            supplierId: row.supplierId,
            productName: row.productName,
            rate,
            unit: row.unit,
            effectiveFrom: row.effectiveFrom,
            effectiveTo: row.effectiveTo,
            spruceItemCode: row.spruceItemCode,
            supplierItemCode: row.supplierItemCode,
          },
        ];
  });

  const openInvoiceLines: RelatedInvoiceLine[] = lineRows.map((row) => ({
    invoiceLineId: row.id,
    invoiceNumber: row.invoice.invoiceNumber,
    lineNumber: row.lineNumber,
    invoiceDate: row.invoice.invoiceDate,
    poNumber: row.poNumber,
    supplierId: row.invoice.supplierId,
    loadIds: [],
  }));

  const hauls = await loadHauls(db, request.haulDates ?? [], haulTolerances.haulDateWindowDays);
  for (const line of hauls.competing) {
    const known = openInvoiceLines.find((other) => other.invoiceLineId === line.invoiceLineId);
    if (known) known.loadIds = line.loadIds;
    else openInvoiceLines.push(line);
  }

  return {
    tolerances,
    haulTolerances,
    suppliers,
    aliases: aliasRows,
    orders,
    tickets,
    rates,
    loads: hauls.loads,
    openInvoiceLines,
  };
}
