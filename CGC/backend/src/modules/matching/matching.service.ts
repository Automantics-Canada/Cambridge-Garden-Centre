import { prisma } from '../../db/prisma.js';
import { MatchSubjectType, TicketStatus, type Prisma } from '@prisma/client';
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
import { resolveTolerances, type Tolerances } from './tolerances.js';
import { deriveLineItemFlag } from '../../lib/lineItemFlag.js';

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

/** Bump when the cascade changes, so old verdicts can be told apart. */
export const ENGINE_VERSION = 3;

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
      poNumber,
      invoiceId: { not: thisLine.invoiceId },
      ...(supplierId ? { invoice: { supplierId } } : {}),
      // A settled line is not contention: it has either claimed its tickets,
      // in which case ticketReuse reports it, or been rejected.
      OR: [{ matchResult: null }, { matchResult: { resolution: null } }],
    },
    select: {
      id: true,
      lineNumber: true,
      invoice: { select: { invoiceNumber: true, invoiceDate: true } },
    },
    take: 20,
  });

  return rows.map((row) => ({
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

  const orderId = shouldAutoLink(decision);

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
  if (!shouldRemoveAutoLink(decision)) return;
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
        hasOrder: decision.orderId !== null,
        ticketCount: decision.ticketIds.length,
        hasQuantityDiscrepancy: quantityDiscrepancy !== null,
        hasRateDiscrepancy: rateDiscrepancy !== null,
        hasAgreedRate: agreedRate !== null,
        rateUnitMismatch: totals?.rateUnitMismatch ?? false,
      }),
    },
  });
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
          where: {
            poNumber: line.poNumber,
            // A ticket whose supplier OCR could not read used to be dropped
            // here, and the line then reported "no delivery ticket accounts for
            // this line" over a load that had plainly arrived. Both are loaded
            // and the engine decides: a different supplier is excluded with a
            // reason, an unknown one is counted and said so.
            ...(supplierId ? { OR: [{ supplierId }, { supplierId: null }] } : {}),
          },
          select: {
            id: true,
            ticketNumber: true,
            poNumber: true,
            quantity: true,
            unit: true,
            // Which product the load was, and who brought it — both needed so
            // one line on a two-product PO does not count the other's tickets.
            material: true,
            supplierId: true,
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
          },
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
    ticketNumber: ticket.ticketNumber,
    poNumber: ticket.poNumber,
    quantity: toNumber(ticket.quantity),
    unit: ticket.unit,
    material: ticket.material,
    supplierId: ticket.supplierId,
    claim: ticket.claim
      ? {
          invoiceLineId: ticket.claim.invoiceLineId,
          invoiceNumber: ticket.claim.invoiceLine.invoice.invoiceNumber,
          lineNumber: ticket.claim.invoiceLine.lineNumber,
          claimedByName: ticket.claim.claimedBy?.name ?? null,
          claimedAt: ticket.claim.claimedAt,
        }
      : null,
  }));

  const competingLines = await loadCompetingLines(line.poNumber, supplierId, line.id);

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
    const tickets = await prisma.ticket.findMany({
      where: {
        poNumber: { in: unique },
        OR: [{ matchResult: null }, { matchResult: { resolution: null } }],
      },
      select: { id: true },
      take: RECOMPUTE_SUBJECT_LIMIT,
    });

    for (const ticket of tickets) {
      await matchTicketById(ticket.id);
    }

    const lines = await prisma.invoiceLineItem.findMany({
      where: {
        poNumber: { in: unique },
        OR: [{ matchResult: null }, { matchResult: { resolution: null } }],
      },
      select: { id: true },
      take: RECOMPUTE_SUBJECT_LIMIT,
    });

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
    const lines = await prisma.invoiceLineItem.findMany({
      where: {
        poNumber: { in: unique },
        OR: [{ matchResult: null }, { matchResult: { resolution: null } }],
      },
      select: { id: true },
      take: RECOMPUTE_SUBJECT_LIMIT,
    });

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
