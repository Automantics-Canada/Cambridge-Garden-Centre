import { prisma } from '../../db/prisma.js';
import { MatchSubjectType, type Prisma } from '@prisma/client';
import {
  matchInvoiceLine,
  matchTicket,
  type AgreedRate,
  type CandidateOrder,
  type DeliveredTicket,
  type MatchDecision,
  type ProductAlias,
} from './matchEngine.js';
import { resolveTolerances, type Tolerances } from './tolerances.js';

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
 */

/** Bump when the cascade changes, so old verdicts can be told apart. */
export const ENGINE_VERSION = 1;

type Decimalish = Prisma.Decimal | number | string | null;

function toNumber(value: Decimalish): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function loadTolerances(): Promise<Tolerances> {
  const settings = await prisma.systemSetting.findMany({
    where: { key: { startsWith: 'match.' } },
    select: { key: true, value: true },
  });
  return resolveTolerances(settings);
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

  if (poNumber) where.push({ poNumber });

  if (supplierId && date) {
    const from = new Date(date.getTime() - windowDays * 86_400_000);
    const to = new Date(date.getTime() + windowDays * 86_400_000);
    where.push({ supplierId, orderDate: { gte: from, lte: to } });
  }

  if (where.length === 0) return [];

  const rows = await prisma.order.findMany({
    where: { OR: where },
    select: {
      id: true,
      poNumber: true,
      product: true,
      quantity: true,
      unit: true,
      supplierId: true,
      orderDate: true,
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
  }));
}

/**
 * Writes a verdict, unless a person has already settled this one.
 *
 * Returns the decision that now stands, so a caller can log what happened
 * rather than assume its own decision was the one stored.
 */
async function persist(
  subjectType: MatchSubjectType,
  subjectId: string,
  decision: MatchDecision
): Promise<{ stored: boolean; reason?: string }> {
  const key =
    subjectType === MatchSubjectType.TICKET
      ? { ticketId: subjectId }
      : { invoiceLineId: subjectId };

  const existing = await prisma.matchResult.findFirst({
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
    engineVersion: ENGINE_VERSION,
    computedAt: new Date(),
  };

  if (existing) {
    await prisma.matchResult.update({ where: { id: existing.id }, data });
  } else {
    await prisma.matchResult.create({ data });
  }

  return { stored: true };
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

  const outcome = await persist(MatchSubjectType.TICKET, ticket.id, decision);
  console.log(
    `[Matching] Ticket ${ticket.id}: ${decision.status}${outcome.stored ? '' : ` (not stored — ${outcome.reason})`}`
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
      invoice: { select: { supplierId: true, invoiceDate: true } },
    },
  });
  if (!line) return null;

  const supplierId = line.invoice?.supplierId ?? null;
  const invoiceDate = line.invoice?.invoiceDate ?? null;
  const tolerances = await loadTolerances();

  const [orders, aliases, tickets, rates] = await Promise.all([
    loadCandidateOrders(line.poNumber, supplierId, invoiceDate, tolerances.dateWindowDays),
    loadAliases(supplierId),
    line.poNumber
      ? prisma.ticket.findMany({
          where: { poNumber: line.poNumber, ...(supplierId ? { supplierId } : {}) },
          select: { id: true, poNumber: true, quantity: true, unit: true },
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
          select: { productName: true, rate: true, unit: true },
        })
      : Promise.resolve([]),
  ]);

  const deliveredTickets: DeliveredTicket[] = tickets.map((ticket) => ({
    id: ticket.id,
    poNumber: ticket.poNumber,
    quantity: toNumber(ticket.quantity),
    unit: ticket.unit,
  }));

  const agreedRates: AgreedRate[] = rates.flatMap((rate) => {
    const value = toNumber(rate.rate);
    return value === null ? [] : [{ productName: rate.productName, rate: value, unit: rate.unit }];
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
    { orders, aliases, tolerances, tickets: deliveredTickets, agreedRates }
  );

  const outcome = await persist(MatchSubjectType.INVOICE_LINE, line.id, decision);
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

/**
 * Re-runs unresolved tickets carrying these POs.
 *
 * A Spruce import can turn yesterday's UNMATCHED ticket into today's match, and
 * nothing else would ever look at it again. Resolved verdicts are skipped here
 * too, by `persist`.
 */
export async function recomputeForPoNumbers(poNumbers: string[]): Promise<number> {
  const unique = [...new Set(poNumbers.filter(Boolean))];
  if (unique.length === 0) return 0;

  const tickets = await prisma.ticket.findMany({
    where: {
      poNumber: { in: unique },
      OR: [{ matchResult: null }, { matchResult: { resolution: null } }],
    },
    select: { id: true },
    take: 500,
  });

  for (const ticket of tickets) {
    await matchTicketById(ticket.id);
  }
  return tickets.length;
}
