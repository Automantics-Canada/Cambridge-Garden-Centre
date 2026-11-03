import { prisma } from '../../db/prisma.js';
import { MatchSubjectType, TicketSource, TicketStatus, type Prisma } from '@prisma/client';
import {
  matchInvoiceLine,
  matchTicket,
  shouldAutoLink,
  shouldRemoveAutoLink,
  type AgreedRate,
  type CandidateOrder,
  type CompetingLine,
  type DeliveredTicket,
  type MatchDecision,
  type ProductAlias,
} from './matchEngine.js';
import { resolveHaulTolerances, resolveTolerances, type HaulTolerances, type Tolerances } from './tolerances.js';
import { matchHaulLine, type CandidateLoad } from './haulMatch.js';
import { deriveLineItemFlag } from '../../lib/lineItemFlag.js';
import { businessDayOf } from '../../lib/businessDay.js';
import { onSamePo, poKey } from './poKey.js';

/**
 * Runs the match engine against stored rows and records what it decided.
 *
 * The engine decides and this writes; nothing here re-implements a comparison.
 * That split is what lets every rule in matchEngine.ts be tested without a
 * database, and it is the same arrangement as reconcileSpruceDocument.ts.
 *
 * The one policy that lives here rather than in the engine: **a verdict a
 * person has resolved is theirs.** Recomputing replaces unresolved rows and
 * leaves resolved ones untouched. Without that rule, re-importing a Spruce
 * report would quietly undo an afternoon of someone's decisions, and nothing on
 * screen would say it had happened.
 *
 * This is also where a ticket's *link* is written, and it is the only place
 * that writes one automatically. There used to be two systems: a cron and the
 * OCR handler both linked a ticket on PO plus driver alone, with no supplier
 * check at all, while the engine reached its own verdict and changed nothing.
 * So the ticket list said LINKED and the verification desk said CONFLICT about
 * the same ticket, and a ticket with no driver — every emailed, messaged or
 * hand-uploaded one — was never linked at all no matter how cleanly it matched.
 * One decision, one writer.
 *
 * A link is not a payment, and the two are held to different bars. Linking says
 * which delivery a load was, and needs the order to have been identified by its
 * PO. Paying says this invoice line is owed, and that is a person resolving a
 * verdict, which writes a TicketClaim and cannot be done twice against the same
 * load. `shouldAutoLink` in the engine is the first bar; `resolveMatch.ts` is
 * the second.
 */

/**
 * Bump when the cascade changes, so old verdicts can be told apart.
 *
 * 5: an agreed rate can be found by the order line's Spruce item code, and
 * quotations are never candidates.
 * 6: two copies of one load (the driver's and the supplier's emailed ticket)
 * count once, must agree, share a claim, and a line backed only by the
 * supplier's own copies is never passed automatically.
 * 7: a trucking company's invoice lines are checked against the dispatch
 * loads they bill and the rate dispatch set (haulMatch.ts), not against
 * order lines and scale tickets.
 * 8: a brokered trip may be billed load by load: a line whose ticket is the
 * one dispatch wrote on one load of the trip bills (and claims) that load
 * alone, and a whole-trip line by the load expects one load per trip load.
 * 9: a haul line that fits several hauls, every one of them already paid, says
 * it is already paid instead of asking a person to choose one. A load by the
 * load with no quantity entered is one load, and a line billed by the load
 * must bill exactly the loads dispatch sent (no estimate tolerance). A load
 * whose quantity only the supplier's emailed copy shows is never passed
 * automatically.
 */
export const ENGINE_VERSION = 9;

/**
 * `matchMethod` recorded for a link the engine made.
 *
 * Distinct from the older AUTO_* values so a row written by the current engine
 * can be told from one left by the PO-and-driver cron that preceded it.
 */
export const ENGINE_MATCH_METHOD = 'AUTO_ENGINE';

/** Every `matchMethod` that means "no person decided this". */
const AUTOMATIC_MATCH_METHODS = [
  ENGINE_MATCH_METHOD,
  'AUTO_PO',
  'AUTO_FALLBACK',
  'AUTO_DRIVER_ASSIGNED',
];

/** `Ticket.linkMethod` is a free-text column; these are the two values used. */
const AUTO_LINK = 'AUTO';
const MANUAL_LINK = 'MANUAL';

type Decimalish = Prisma.Decimal | number | string | null;

function toNumber(value: Decimalish): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Rows whose stored PO could be this one, for a `where: { OR: [...] }`.
 *
 * POs are compared on a key (poKey.ts), but the column holds whatever was
 * printed or typed: `2608-355356`, `PO# 2608-355356`, `355356`. Every one of
 * those spellings contains the six digit suffix, so the database is asked for
 * that — plus the exact text, so a value that is not a PO in either form still
 * finds its exact twin as it always did. This is deliberately wider than a
 * match; the engine, or the filter beside each caller, narrows it on the key.
 */
function poNumberConditions(poNumber: string): Array<{ poNumber: string | { contains: string } }> {
  const conditions: Array<{ poNumber: string | { contains: string } }> = [{ poNumber }];
  const key = poKey(poNumber);
  if (key) conditions.push({ poNumber: { contains: key.suffix } });
  return conditions;
}

async function loadMatchSettings(db: Pick<Prisma.TransactionClient, 'systemSetting'> = prisma) {
  return db.systemSetting.findMany({
    where: { key: { startsWith: 'match.' } },
    select: { key: true, value: true },
  });
}

async function loadTolerances(): Promise<Tolerances> {
  return resolveTolerances(await loadMatchSettings());
}

export async function loadHaulTolerances(
  db: Pick<Prisma.TransactionClient, 'systemSetting'> = prisma
): Promise<HaulTolerances> {
  return resolveHaulTolerances(await loadMatchSettings(db));
}

async function loadAliases(supplierId: string | null): Promise<ProductAlias[]> {
  if (!supplierId) return [];
  const rows = await prisma.supplierProductAlias.findMany({
    where: { supplierId },
    select: { supplierId: true, aliasText: true, productName: true },
  });
  return rows;
}

/**
 * Order lines that can never back a ticket or an invoice: those on a document
 * the import recognised as a quotation (QUOTE). A quote is a price someone was
 * given, not material anyone ordered. Its lines carry the same supplier and
 * dates as real orders, so without this a quote could be offered as a match,
 * or stand beside the real order as a second candidate and turn a good invoice
 * line into CONFLICT.
 *
 * NOT_OPEN is deliberately not excluded, although the dispatch board leaves it
 * out as well. The board shows work still to do, and a NOT_OPEN order has none:
 * it was invoiced, closed or voided in Spruce since. Matching looks backwards.
 * The supplier's invoice and the late tickets for an order arrive after the
 * order was delivered and invoiced, which is exactly when it leaves the Order
 * report and is flagged NOT_OPEN. Excluding it here would leave every finished
 * order's supplier invoice unmatched.
 *
 * A line with no document (rows from the legacy import) is kept: nothing says
 * it is a quote.
 */
export const NOT_ON_A_QUOTATION: Prisma.OrderWhereInput = {
  NOT: { document: { is: { flags: { has: 'QUOTE' } } } },
};

/** Whether this order line is on a quotation, for the automatic ticket link. */
async function isOnQuotation(tx: Prisma.TransactionClient, orderId: string): Promise<boolean> {
  const row = await tx.order.findUnique({
    where: { id: orderId },
    select: { document: { select: { flags: true } } },
  });
  return row?.document?.flags.includes('QUOTE') ?? false;
}

/**
 * Orders worth considering for one subject.
 *
 * Deliberately narrow. Loading every order to let the engine filter would work
 * and would also read the whole table on every ticket; this asks the database
 * for the same two routes the engine uses — the PO, or the supplier within the
 * date window — and lets it use its indexes.
 */
async function loadCandidateOrders(
  poNumber: string | null,
  supplierId: string | null,
  date: Date | null,
  windowDays: number
): Promise<CandidateOrder[]> {
  const where: Prisma.OrderWhereInput[] = [];

  if (poNumber) where.push(...poNumberConditions(poNumber));

  if (supplierId && date) {
    const from = new Date(date.getTime() - windowDays * 86_400_000);
    const to = new Date(date.getTime() + windowDays * 86_400_000);
    where.push({ supplierId, orderDate: { gte: from, lte: to } });
    // An order only the delivery report has seen has no order date; its
    // delivery date stands in, exactly as it does in the engine.
    where.push({ supplierId, orderDate: null, deliveryDate: { gte: from, lte: to } });
  }

  if (where.length === 0) return [];

  const rows = await prisma.order.findMany({
    // Both routes, the PO and the supplier within the window, leave quotations
    // out; see NOT_ON_A_QUOTATION.
    where: { AND: [{ OR: where }, NOT_ON_A_QUOTATION] },
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
    },
    // A subject that somehow matches hundreds of orders is a data problem, not
    // a match; the engine will call it a CONFLICT either way, and this stops
    // one bad row pulling the table into memory.
    take: 200,
  });

  return rows.map((row) => ({
    id: row.id,
    poNumber: row.poNumber,
    product: row.product,
    quantity: toNumber(row.quantity),
    unit: row.unit,
    supplierId: row.supplierId,
    orderDate: row.orderDate,
    deliveryDate: row.deliveryDate,
    spruceItemNumber: row.spruceItemNumber,
  }));
}

/**
 * Other invoice lines billing this PO that nobody has ruled on yet.
 *
 * Contention is derived rather than stored, so both lines see each other and
 * neither goes green purely for having been matched first. Lines on the same
 * invoice are excluded: a supplier listing one PO twice on one document is a
 * question about that document, not a competing claim between invoices.
 */
async function loadCompetingLines(
  poNumber: string | null,
  supplierId: string | null,
  excludeLineId: string
): Promise<CompetingLine[]> {
  if (!poNumber) return [];

  const thisLine = await prisma.invoiceLineItem.findUnique({
    where: { id: excludeLineId },
    select: { invoiceId: true },
  });
  if (!thisLine) return [];

  const rows = await prisma.invoiceLineItem.findMany({
    where: {
      invoiceId: { not: thisLine.invoiceId },
      ...(supplierId ? { invoice: { supplierId } } : {}),
      AND: [
        { OR: poNumberConditions(poNumber) },
        // A settled line is not contention: it has either claimed its tickets,
        // in which case ticketReuse reports it, or been rejected.
        { OR: [{ matchResult: null }, { matchResult: { resolution: null } }] },
      ],
    },
    select: {
      id: true,
      poNumber: true,
      lineNumber: true,
      invoice: { select: { invoiceNumber: true, invoiceDate: true } },
    },
    take: 20,
  });

  return rows.filter((row) => onSamePo(row.poNumber, poNumber)).map((row) => ({
    invoiceLineId: row.id,
    invoiceNumber: row.invoice.invoiceNumber,
    lineNumber: row.lineNumber,
    invoiceDate: row.invoice.invoiceDate,
  }));
}

/**
 * Writes a verdict, unless a person has already settled this one.
 *
 * Returns the decision that now stands, so a caller can log what happened
 * rather than assume its own decision was the one stored.
 *
 * `alsoApply` runs inside the same transaction and only when the verdict was
 * actually stored. That is how the ticket link cannot drift from the verdict
 * that justifies it: either both land or neither does, and nothing runs at all
 * against a verdict a person has resolved. The resolved check is made inside
 * the transaction too — reading it outside left a window where somebody
 * confirmed a ticket between the read and the write, and the recompute then
 * overwrote them.
 */
async function persist(
  subjectType: MatchSubjectType,
  subjectId: string,
  decision: MatchDecision,
  alsoApply?: (tx: Prisma.TransactionClient) => Promise<void>
): Promise<{ stored: boolean; reason?: string }> {
  const key =
    subjectType === MatchSubjectType.TICKET
      ? { ticketId: subjectId }
      : { invoiceLineId: subjectId };

  return prisma.$transaction(async (tx) => {
    const existing = await tx.matchResult.findFirst({
      where: key,
      select: { id: true, resolution: true },
    });

    if (existing?.resolution) {
      return { stored: false, reason: 'a person has already resolved this' };
    }

    const data = {
      subjectType,
      ...key,
      orderId: decision.orderId,
      status: decision.status,
      evidence: decision.checks as unknown as Prisma.InputJsonValue,
      reason: decision.reason,
      candidateOrderIds: decision.candidateOrderIds,
      // Stored so a resolution claims exactly what this verdict counted, rather
      // than whatever tickets happen to exist when somebody clicks Confirm.
      ticketIds: decision.ticketIds,
      // The same for a trucking line's dispatch loads. Written on every
      // verdict, so a line that stops being a haul line holds none.
      loadIds: decision.loadIds ?? [],
      engineVersion: ENGINE_VERSION,
      computedAt: new Date(),
    };

    if (existing) {
      await tx.matchResult.update({ where: { id: existing.id }, data });
    } else {
      await tx.matchResult.create({ data });
    }

    if (alsoApply) await alsoApply(tx);

    return { stored: true };
  });
}

/**
 * Makes the verdict the ticket's actual link, or takes away one the engine can
 * no longer support.
 *
 * The rule itself is `shouldAutoLink` / `shouldRemoveAutoLink` in the engine,
 * where it is pure and tested. What matters here is the distinction it rests
 * on: **linking is not paying.** Attaching a ticket to an order records which
 * delivery a load was. Money is committed only when somebody resolves an
 * invoice line, which has its own refusals and writes a TicketClaim. So the bar
 * for a link is that the order was identified by its PO, not that every check
 * passed.
 *
 * An earlier version of this linked only on MATCHED, which would have detached
 * most of the yard's tickets the first time it ran. MATCHED also wants the
 * ticket's material wording to equal the Spruce product wording exactly, and a
 * ticket reading "3/4 clear" against a line reading "STONE 3/4 CLEAR LIMESTONE"
 * is PARTIAL until somebody records that alias — almost none are recorded yet.
 * That discrepancy still has to be seen, and it is: PARTIAL on the verification
 * desk with the failing check named. Detaching a yard's worth of correct
 * deliveries to say so would read as the system breaking, and the people who
 * had to undo it by hand would trust the next warning less.
 *
 * A person's link is never touched. MANUAL means somebody is accountable for
 * it, and the engine disagreeing is an argument to be had on the desk, not a
 * reason to silently undo them.
 */
async function applyAutomaticTicketLink(
  tx: Prisma.TransactionClient,
  ticketId: string,
  decision: MatchDecision
): Promise<void> {
  const ticket = await tx.ticket.findUnique({
    where: { id: ticketId },
    select: { linkedOrderId: true, status: true, linkMethod: true },
  });
  if (!ticket) return;

  // REVIEWED is a person saying they have looked at this one. Nothing here is
  // worth overriding that with.
  if (ticket.linkMethod === MANUAL_LINK || ticket.status === TicketStatus.REVIEWED) return;

  // The candidates never include a quotation's lines, so the engine cannot
  // name one. Checked here as well because this writes the link: a ticket must
  // never be attached to a quote, and one attached before the document was
  // recognised as a quote has its automatic link taken away below.
  const proposed = shouldAutoLink(decision);
  const orderId = proposed && !(await isOnQuotation(tx, proposed)) ? proposed : null;
  const linkedToQuotation =
    ticket.linkedOrderId !== null && (await isOnQuotation(tx, ticket.linkedOrderId));

  if (orderId) {
    // Writing the identical row again changes nothing but wakes every realtime
    // subscriber watching the ticket — the update loop the old cron had to
    // guard against by hand.
    if (
      ticket.linkedOrderId === orderId &&
      ticket.status === TicketStatus.LINKED &&
      ticket.linkMethod === AUTO_LINK
    ) {
      return;
    }

    await tx.ticketOrderMatch.upsert({
      where: { ticketId_orderId: { ticketId, orderId } },
      create: { ticketId, orderId, matchMethod: ENGINE_MATCH_METHOD },
      // An older AUTO_PO row for the same pair is restamped rather than left
      // claiming a cron that no longer exists decided it.
      update: { matchMethod: ENGINE_MATCH_METHOD },
    });

    // An automatic link to some other order is stale the moment this one is
    // written. Left behind, the ticket appears against two orders at once and
    // the order screens count the same delivery twice.
    await tx.ticketOrderMatch.deleteMany({
      where: {
        ticketId,
        orderId: { not: orderId },
        matchMethod: { in: AUTOMATIC_MATCH_METHODS },
      },
    });

    await tx.ticket.update({
      where: { id: ticketId },
      data: { linkedOrderId: orderId, status: TicketStatus.LINKED, linkMethod: AUTO_LINK },
    });
    return;
  }

  // Nothing identifiable to link to. Only CONFLICT and UNMATCHED take a link
  // away — a PARTIAL still knows which order this is, and an order found only
  // by the supplier/date/product fallback is left exactly as it was for a
  // person to settle. And only an automatic link: a ticket carrying no link
  // method has nothing here to undo, and MANUAL was returned from above.
  // The one exception is an automatic link to a quotation, which is never
  // right whatever the verdict now says.
  if (!shouldRemoveAutoLink(decision) && !linkedToQuotation) return;
  if (ticket.linkMethod !== AUTO_LINK) return;

  await tx.ticketOrderMatch.deleteMany({
    where: { ticketId, matchMethod: { in: AUTOMATIC_MATCH_METHODS } },
  });
  await tx.ticket.update({
    where: { id: ticketId },
    data: { linkedOrderId: null, status: TicketStatus.UNLINKED, linkMethod: null },
  });
}

/** Decides and records whether one delivery ticket is backed by an order. */
export async function matchTicketById(ticketId: string): Promise<MatchDecision | null> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      poNumber: true,
      material: true,
      quantity: true,
      unit: true,
      supplierId: true,
      ticketDate: true,
    },
  });
  if (!ticket) return null;

  const tolerances = await loadTolerances();
  const [orders, aliases] = await Promise.all([
    loadCandidateOrders(
      ticket.poNumber,
      ticket.supplierId,
      ticket.ticketDate,
      tolerances.dateWindowDays
    ),
    loadAliases(ticket.supplierId),
  ]);

  const decision = matchTicket(
    {
      id: ticket.id,
      poNumber: ticket.poNumber,
      material: ticket.material,
      quantity: toNumber(ticket.quantity),
      unit: ticket.unit,
      supplierId: ticket.supplierId,
      ticketDate: ticket.ticketDate,
    },
    { orders, aliases, tolerances }
  );

  const outcome = await persist(MatchSubjectType.TICKET, ticket.id, decision, (tx) =>
    applyAutomaticTicketLink(tx, ticket.id, decision)
  );
  console.log(
    `[Matching] Ticket ${ticket.id}: ${decision.status}${outcome.stored ? '' : ` (not stored — ${outcome.reason})`}`
  );
  return decision;
}

/**
 * Projects the verdict onto the columns the invoice screens read.
 *
 * `matchedOrderId`, `negotiatedRate`, `rateDiscrepancy`, `qtyDiscrepancy`,
 * `approvedTotal` and `flag` live on the line itself, and they used to be
 * computed separately, by a looser comparison, at extraction time only. So a
 * line could say "matched, priced, OK" while the verdict beside it said the
 * product was unrecognised — and a later recompute changed the verdict and
 * left the columns as they were. They are written here, from the same decision
 * and in the same transaction, so the two cannot drift.
 *
 * A verdict a person has resolved never reaches this: `persist` returns before
 * calling it, which is what stops a recompute undoing their link.
 */
async function applyLineItemColumns(
  tx: Prisma.TransactionClient,
  lineItemId: string,
  billedQuantity: number | null,
  decision: MatchDecision
): Promise<void> {
  const totals = decision.totals;
  const agreedRate = totals?.agreedRate ?? null;
  // A haul line is backed by the dispatch load it bills, not by an order line
  // and its scale tickets: the load stands for both in the flag.
  const haulLoads = decision.loadIds?.length ?? null;
  const rateDiscrepancy = totals?.rateDiscrepancy ?? null;
  const quantityDiscrepancy = totals?.quantityDiscrepancy ?? null;

  await tx.invoiceLineItem.update({
    where: { id: lineItemId },
    data: {
      // Only a single surviving order counts. A CONFLICT leaves this null on
      // purpose: naming one of several orders here would present a choice
      // nobody made as a decision already taken.
      matchedOrderId: decision.orderId,
      // Exactly the loads the verdict counted — not every ticket on the PO,
      // which on a two-product PO meant each line claimed the other's.
      matchedTickets: { set: decision.ticketIds.map((id) => ({ id })) },
      negotiatedRate: agreedRate,
      rateDiscrepancy,
      qtyDiscrepancy: quantityDiscrepancy,
      approvedTotal:
        agreedRate === null || billedQuantity === null ? null : billedQuantity * agreedRate,
      flag: deriveLineItemFlag({
        hasOrder: haulLoads === null ? decision.orderId !== null : haulLoads > 0,
        ticketCount: haulLoads ?? decision.ticketIds.length,
        hasQuantityDiscrepancy: quantityDiscrepancy !== null,
        hasRateDiscrepancy: rateDiscrepancy !== null,
        hasAgreedRate: agreedRate !== null,
        rateUnitMismatch: totals?.rateUnitMismatch ?? false,
      }),
    },
  });
}

/** What the engine needs of each ticket that might cover an invoice line. */
const DELIVERED_TICKET_SELECT = {
  id: true,
  ticketNumber: true,
  poNumber: true,
  quantity: true,
  unit: true,
  // Which product the load was, and who brought it — both needed so one line
  // on a two-product PO does not count the other's tickets.
  material: true,
  supplierId: true,
  // Which copy of a load this is, and whether the supplier emailed it.
  source: true,
  duplicateOfTicketId: true,
  ticketDate: true,
  // Whether somebody has already paid a line against this load.
  claim: {
    select: {
      invoiceLineId: true,
      claimedAt: true,
      claimedBy: { select: { name: true } },
      invoiceLine: {
        select: { lineNumber: true, invoice: { select: { invoiceNumber: true } } },
      },
    },
  },
} as const satisfies Prisma.TicketSelect;

type DeliveredTicketRow = Prisma.TicketGetPayload<{ select: typeof DELIVERED_TICKET_SELECT }>;

function toDeliveredTicket(ticket: DeliveredTicketRow): DeliveredTicket {
  return {
    id: ticket.id,
    ticketNumber: ticket.ticketNumber,
    poNumber: ticket.poNumber,
    quantity: toNumber(ticket.quantity),
    unit: ticket.unit,
    material: ticket.material,
    supplierId: ticket.supplierId,
    duplicateOfTicketId: ticket.duplicateOfTicketId,
    emailedBySupplier: ticket.source === TicketSource.EMAIL,
    ticketDate: ticket.ticketDate,
    claim: ticket.claim
      ? {
          invoiceLineId: ticket.claim.invoiceLineId,
          invoiceNumber: ticket.claim.invoiceLine.invoice.invoiceNumber,
          lineNumber: ticket.claim.invoiceLine.lineNumber,
          claimedByName: ticket.claim.claimedBy?.name ?? null,
          claimedAt: ticket.claim.claimedAt,
        }
      : null,
  };
}

/** What the haul matcher needs of each dispatch load. Office-side only. */
const CANDIDATE_LOAD_SELECT = {
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

type CandidateLoadRow = Prisma.DispatchLoadGetPayload<{ select: typeof CANDIDATE_LOAD_SELECT }>;

/**
 * The day a load was hauled. DispatchLoad has no date of its own: the
 * order's delivery date is the day Spruce scheduled it, the stop's completion
 * the day it was done, and the day dispatch recorded the load the last resort.
 *
 * The matcher compares calendar days (`YYYY-MM-DD`, at UTC midnight), which a
 * delivery date already is. The other two are instants, so they are turned
 * into the yard's day first: a load finished at 9 pm in Cambridge is already
 * the next day in UTC, and would otherwise miss a line dated the day it ran.
 */
export function haulDateOf(row: {
  document: { deliveryDate: Date | null };
  delivery: { completedAt: Date | null } | null;
  createdAt: Date;
}): Date {
  if (row.document.deliveryDate) return row.document.deliveryDate;
  const instant = row.delivery?.completedAt ?? row.createdAt;
  return new Date(`${businessDayOf(instant)}T00:00:00.000Z`);
}

function toCandidateLoad(row: CandidateLoadRow): CandidateLoad {
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
      ...new Set(
        [row.document.poNumber, ...row.document.lines.map((orderLine) => orderLine.poNumber)].filter(
          (po): po is string => Boolean(po)
        )
      ),
    ],
    orderTicketNumbers: row.document.lines.flatMap((orderLine) =>
      orderLine.tickets.flatMap((ticket) => (ticket.ticketNumber ? [ticket.ticketNumber] : []))
    ),
    orderLineId: row.document.lines[0]?.id ?? null,
    claim: row.claimedByLineItem
      ? {
          invoiceNumber: row.claimedByLineItem.invoice.invoiceNumber,
          lineNumber: row.claimedByLineItem.lineNumber,
        }
      : null,
  };
}

/** Dispatch loads as the haul matcher reads them, for any filter. */
export async function loadCandidateLoads(
  where: Prisma.DispatchLoadWhereInput,
  db: Pick<Prisma.TransactionClient, 'dispatchLoad'> = prisma
): Promise<CandidateLoad[]> {
  const rows = await db.dispatchLoad.findMany({
    where,
    select: CANDIDATE_LOAD_SELECT,
    // Newest first, so that if the bound below is ever reached it drops the
    // oldest loads rather than the ones an invoice is most likely billing.
    orderBy: [{ createdAt: 'desc' }],
    // A carrier with hundreds of loads in a fortnight is a data problem; the
    // matcher would call the line a CONFLICT either way.
    take: 500,
  });
  // Back in the order dispatch recorded them, which is the order they are listed in.
  return rows.reverse().map(toCandidateLoad);
}

/**
 * A carrier's dispatch loads that could be dated inside the window. Asked a
 * day wider on each side than the matcher's window, by each of the three
 * dates a load's haul day can come from; the matcher applies the exact
 * window. CGC's own trucks (no carrier) are never read.
 */
export async function loadHaulCandidates(
  carrierSupplierId: string,
  anchor: Date,
  windowDays: number,
  db: Pick<Prisma.TransactionClient, 'dispatchLoad'> = prisma
): Promise<CandidateLoad[]> {
  const from = new Date(anchor.getTime() - (windowDays + 1) * 86_400_000);
  const to = new Date(anchor.getTime() + (windowDays + 1) * 86_400_000);
  return loadCandidateLoads(
    {
      carrierSupplierId,
      OR: [
        { document: { deliveryDate: { gte: from, lte: to } } },
        { delivery: { completedAt: { gte: from, lte: to } } },
        { createdAt: { gte: from, lte: to } },
      ],
    },
    db
  );
}

/**
 * A trucking company's invoice line, against the dispatch loads it bills
 * (client, Oct 2026, Q14). Material lines never come here.
 */
async function matchHaulLineById(line: {
  id: string;
  poNumber: string | null;
  ticketNumber: string | null;
  serviceDate: Date | null;
  quantity: Prisma.Decimal;
  unit: string;
  unitRate: Prisma.Decimal;
  invoice: { supplierId: string; invoiceDate: Date };
}): Promise<MatchDecision> {
  const tolerances = await loadHaulTolerances();
  const anchor = line.serviceDate ?? line.invoice.invoiceDate;
  const loads = await loadHaulCandidates(line.invoice.supplierId, anchor, tolerances.haulDateWindowDays);

  // Other unsettled lines whose verdicts count any of these loads.
  const candidateIds = loads.map((load) => load.id);
  const competing =
    candidateIds.length === 0
      ? []
      : await prisma.matchResult.findMany({
          where: { invoiceLineId: { not: line.id }, resolution: null, loadIds: { hasSome: candidateIds } },
          select: {
            invoiceLineId: true,
            loadIds: true,
            invoiceLine: { select: { lineNumber: true, invoice: { select: { invoiceNumber: true } } } },
          },
          take: 50,
        });

  const decision = matchHaulLine(
    {
      id: line.id,
      poNumber: line.poNumber,
      ticketNumber: line.ticketNumber,
      serviceDate: line.serviceDate,
      quantity: toNumber(line.quantity),
      unit: line.unit,
      unitRate: toNumber(line.unitRate),
      supplierId: line.invoice.supplierId,
      invoiceDate: line.invoice.invoiceDate,
    },
    loads,
    {
      tolerances,
      competingLines: competing.flatMap((other) =>
        other.invoiceLineId && other.invoiceLine
          ? [
              {
                invoiceLineId: other.invoiceLineId,
                invoiceNumber: other.invoiceLine.invoice.invoiceNumber,
                lineNumber: other.invoiceLine.lineNumber,
                loadIds: other.loadIds,
              },
            ]
          : []
      ),
    }
  );

  const outcome = await persist(MatchSubjectType.INVOICE_LINE, line.id, decision, (tx) =>
    applyLineItemColumns(tx, line.id, toNumber(line.quantity), decision)
  );
  console.log(
    `[Matching] Haul line ${line.id}: ${decision.status}${outcome.stored ? '' : ` (not stored — ${outcome.reason})`}`
  );
  return decision;
}

/** Decides and records whether one invoice line is safe to pay. */
export async function matchInvoiceLineById(lineId: string): Promise<MatchDecision | null> {
  const line = await prisma.invoiceLineItem.findUnique({
    where: { id: lineId },
    select: {
      id: true,
      poNumber: true,
      description: true,
      quantity: true,
      unit: true,
      unitRate: true,
      ticketNumber: true,
      serviceDate: true,
      invoice: { select: { supplierId: true, invoiceDate: true, supplier: { select: { type: true } } } },
    },
  });
  if (!line) return null;

  // A trucking company bills hauls, which are checked against what dispatch
  // recorded for each load. Everything else keeps the order-and-ticket path.
  if (line.invoice.supplier.type === 'TRUCKING_COMPANY') {
    return matchHaulLineById(line);
  }

  const supplierId = line.invoice?.supplierId ?? null;
  const invoiceDate = line.invoice?.invoiceDate ?? null;
  const tolerances = await loadTolerances();

  const [orders, aliases, tickets, rates] = await Promise.all([
    loadCandidateOrders(line.poNumber, supplierId, invoiceDate, tolerances.dateWindowDays),
    loadAliases(supplierId),
    line.poNumber
      ? prisma.ticket.findMany({
          where: {
            AND: [
              // Every spelling of this PO; the engine keeps those on its key.
              { OR: poNumberConditions(line.poNumber) },
              // A ticket whose supplier OCR could not read used to be dropped
              // here, and the line then reported "no delivery ticket accounts
              // for this line" over a load that had plainly arrived. Both are
              // loaded and the engine decides: a different supplier is excluded
              // with a reason, an unknown one is counted and said so.
              ...(supplierId ? [{ OR: [{ supplierId }, { supplierId: null }] }] : []),
            ],
          },
          select: DELIVERED_TICKET_SELECT,
          take: 100,
        })
      : Promise.resolve([]),
    supplierId
      ? prisma.negotiatedRate.findMany({
          where: {
            supplierId,
            effectiveFrom: { lte: invoiceDate ?? new Date() },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: invoiceDate ?? new Date() } }],
          },
          select: {
            productName: true,
            rate: true,
            unit: true,
            spruceItemCode: true,
            supplierItemCode: true,
          },
        })
      : Promise.resolve([]),
  ]);

  // The other copies of these loads, wherever their PO points: the engine
  // counts each load once and compares its copies, so it needs all of them.
  const loaded = new Set(tickets.map((ticket) => ticket.id));
  const roots = [...new Set(tickets.map((ticket) => ticket.duplicateOfTicketId ?? ticket.id))];
  const twins =
    tickets.length === 0
      ? []
      : await prisma.ticket.findMany({
          where: {
            id: { notIn: [...loaded] },
            OR: [{ id: { in: roots } }, { duplicateOfTicketId: { in: roots } }],
          },
          select: DELIVERED_TICKET_SELECT,
          take: 100,
        });

  const deliveredTickets: DeliveredTicket[] = [...tickets, ...twins].map(toDeliveredTicket);

  const competingLines = await loadCompetingLines(line.poNumber, supplierId, line.id);

  const agreedRates: AgreedRate[] = rates.flatMap((rate) => {
    const value = toNumber(rate.rate);
    return value === null
      ? []
      : [
          {
            productName: rate.productName,
            rate: value,
            unit: rate.unit,
            spruceItemCode: rate.spruceItemCode,
            supplierItemCode: rate.supplierItemCode,
          },
        ];
  });

  const decision = matchInvoiceLine(
    {
      id: line.id,
      poNumber: line.poNumber,
      description: line.description,
      quantity: toNumber(line.quantity),
      unit: line.unit,
      unitRate: toNumber(line.unitRate),
      supplierId,
      invoiceDate,
    },
    { orders, aliases, tolerances, tickets: deliveredTickets, agreedRates, competingLines }
  );

  const outcome = await persist(MatchSubjectType.INVOICE_LINE, line.id, decision, (tx) =>
    applyLineItemColumns(tx, line.id, toNumber(line.quantity), decision)
  );
  console.log(
    `[Matching] Invoice line ${line.id}: ${decision.status}${outcome.stored ? '' : ` (not stored — ${outcome.reason})`}`
  );
  return decision;
}

/** Every line on one invoice, in order. */
export async function matchInvoiceById(invoiceId: string): Promise<MatchDecision[]> {
  const lines = await prisma.invoiceLineItem.findMany({
    where: { invoiceId },
    select: { id: true },
    orderBy: { lineNumber: 'asc' },
  });

  const decisions: MatchDecision[] = [];
  for (const line of lines) {
    const decision = await matchInvoiceLineById(line.id);
    if (decision) decisions.push(decision);
  }
  return decisions;
}

/** Ceilings on one recompute, so a bad PO cannot pull the table into memory. */
const RECOMPUTE_PO_LIMIT = 200;
const RECOMPUTE_SUBJECT_LIMIT = 500;

/**
 * Whether a stored PO is any of these. A Spruce import touches
 * `2608-355356`; the ticket that load arrived on may say `355356` or
 * `PO# 2608-355356`, and it is exactly the one that needs re-deciding.
 */
function onAnyOf(stored: string | null, poNumbers: string[]): boolean {
  return poNumbers.some((po) => onSamePo(stored, po));
}

/** Unresolved invoice lines carrying any spelling of these POs. */
async function loadUnsettledLinesOnPos(poNumbers: string[]): Promise<Array<{ id: string }>> {
  const rows = await prisma.invoiceLineItem.findMany({
    where: {
      AND: [
        { OR: poNumbers.flatMap(poNumberConditions) },
        { OR: [{ matchResult: null }, { matchResult: { resolution: null } }] },
      ],
    },
    select: { id: true, poNumber: true },
    take: RECOMPUTE_SUBJECT_LIMIT,
  });
  return rows.filter((row) => onAnyOf(row.poNumber, poNumbers));
}

/**
 * POs a recompute is currently running for, in this process.
 *
 * The paths that trigger a recompute can reach each other — resolving a line
 * recomputes its PO, and a ticket's OCR recomputes the lines on its PO — so a
 * PO already in flight is skipped rather than started again. It is a re-entry
 * guard and nothing more: one process, and a second server would still run its
 * own. That is acceptable because a recompute is idempotent; what it prevents
 * is a chain of calls within one request growing without bound.
 */
const recomputing = new Set<string>();

/**
 * Re-runs unresolved tickets and unresolved invoice lines carrying these POs.
 *
 * A Spruce import can turn yesterday's UNMATCHED ticket into today's match, and
 * an invoice line photographed before its tickets arrived stays "no delivery
 * ticket accounts for this line" forever — nothing else would ever look at
 * either of them again. Resolved verdicts are skipped here too, by `persist`.
 *
 * Tickets run first: a ticket's verdict does not depend on any invoice, but a
 * line's coverage depends on which tickets exist and which are spent.
 */
export async function recomputeForPoNumbers(
  poNumbers: string[]
): Promise<{ tickets: number; invoiceLines: number }> {
  const unique = [...new Set(poNumbers.filter(Boolean))]
    .filter((po) => !recomputing.has(po))
    .slice(0, RECOMPUTE_PO_LIMIT);
  if (unique.length === 0) return { tickets: 0, invoiceLines: 0 };

  for (const po of unique) recomputing.add(po);
  try {
    const tickets = (
      await prisma.ticket.findMany({
        where: {
          AND: [
            { OR: unique.flatMap(poNumberConditions) },
            { OR: [{ matchResult: null }, { matchResult: { resolution: null } }] },
          ],
        },
        select: { id: true, poNumber: true },
        take: RECOMPUTE_SUBJECT_LIMIT,
      })
    ).filter((ticket) => onAnyOf(ticket.poNumber, unique));

    for (const ticket of tickets) {
      await matchTicketById(ticket.id);
    }

    const lines = await loadUnsettledLinesOnPos(unique);

    for (const line of lines) {
      await matchInvoiceLineById(line.id);
    }

    return { tickets: tickets.length, invoiceLines: lines.length };
  } finally {
    for (const po of unique) recomputing.delete(po);
  }
}

/** Re-runs only the unresolved invoice lines on these POs. */
export async function recomputeInvoiceLinesForPoNumbers(poNumbers: string[]): Promise<number> {
  const unique = [...new Set(poNumbers.filter(Boolean))]
    .filter((po) => !recomputing.has(po))
    .slice(0, RECOMPUTE_PO_LIMIT);
  if (unique.length === 0) return 0;

  for (const po of unique) recomputing.add(po);
  try {
    const lines = await loadUnsettledLinesOnPos(unique);

    for (const line of lines) {
      await matchInvoiceLineById(line.id);
    }
    return lines.length;
  } finally {
    for (const po of unique) recomputing.delete(po);
  }
}

/**
 * A recompute that reports rather than fails.
 *
 * Every caller is finishing something else — an order import, an OCR run, a
 * person's resolution — that has already succeeded and committed. Matching is
 * advisory: refusing an import that landed correctly because a later recompute
 * hit a deadlock would be a worse outcome than a stale verdict the next sweep
 * picks up.
 */
export async function recomputeForPoNumbersSafely(
  poNumbers: string[],
  context: string
): Promise<void> {
  const unique = [...new Set(poNumbers.filter(Boolean))];
  if (unique.length === 0) return;

  try {
    const counts = await recomputeForPoNumbers(unique);
    console.log(
      `[Matching] ${context}: recomputed ${counts.tickets} ticket(s) and ` +
        `${counts.invoiceLines} invoice line(s) across ${unique.length} PO(s).`
    );
  } catch (error) {
    console.error(`[Matching] ${context}: recompute failed for ${unique.length} PO(s):`, error);
  }
}

/** As `recomputeForPoNumbersSafely`, for the invoice lines alone. */
export async function recomputeInvoiceLinesSafely(
  poNumbers: string[],
  context: string
): Promise<void> {
  const unique = [...new Set(poNumbers.filter(Boolean))];
  if (unique.length === 0) return;

  try {
    const count = await recomputeInvoiceLinesForPoNumbers(unique);
    console.log(`[Matching] ${context}: recomputed ${count} invoice line(s).`);
  } catch (error) {
    console.error(`[Matching] ${context}: invoice line recompute failed:`, error);
  }
}

/**
 * Re-runs one supplier's unresolved invoice lines, after its rates changed.
 *
 * Until price lists are loaded, every line reads "no agreed rate". Once a
 * rate is added, nothing else would look at those lines again: the invoice
 * would keep saying the rate is missing until someone re-ran it by hand. This
 * is what re-runs them.
 *
 * Only invoices still being worked on (not VERIFIED or PAID) are touched, and
 * `persist` leaves alone any verdict a person has resolved. Bounded, so one
 * supplier with a long backlog cannot pull the whole ledger into a single
 * pass. Newest invoice first: those are the ones a new price list is about,
 * and the lines still unresolved after a pass are picked again by the next
 * one, so starting from the oldest would re-check the same old lines every
 * time and never reach this week's invoices. Lines beyond the limit wait for
 * a manual re-run of their invoice.
 */
export const RECOMPUTE_SUPPLIER_LINE_LIMIT = 500;

export async function recomputeInvoiceLinesForSupplier(
  supplierId: string,
  limit = RECOMPUTE_SUPPLIER_LINE_LIMIT
): Promise<{ lines: number; invoiceIds: string[]; capped: boolean }> {
  const lines = await prisma.invoiceLineItem.findMany({
    where: {
      invoice: { supplierId, status: { in: ['PENDING_REVIEW', 'DISPUTED'] } },
      OR: [{ matchResult: null }, { matchResult: { resolution: null } }],
    },
    select: { id: true, invoiceId: true },
    orderBy: [{ invoice: { invoiceDate: 'desc' } }, { invoiceId: 'asc' }, { lineNumber: 'asc' }],
    take: limit + 1,
  });

  const capped = lines.length > limit;
  const batch = lines.slice(0, limit);
  for (const line of batch) {
    await matchInvoiceLineById(line.id);
  }

  return { lines: batch.length, invoiceIds: [...new Set(batch.map((line) => line.invoiceId))], capped };
}
