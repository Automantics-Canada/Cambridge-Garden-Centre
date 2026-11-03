/**
 * Two copies of one load: the driver's photo and the supplier's emailed copy.
 *
 * Most tickets come from the drivers, and some suppliers also attach their
 * tickets to the invoice email (A15). Filed as two tickets, the same load
 * would be counted twice: the delivered quantity doubles and hides an
 * over-billed line, and a repeat invoice could be paid against the second
 * copy, past the one-claim-per-ticket rule (TicketClaim.ticketId is unique per
 * row, not per load).
 *
 * Copies are recognised by what the paper itself says: the same supplier and
 * the same ticket number, compared on the letters and digits only (the same
 * reduction ticket search uses, `numberSearchKey`). One copy counts, the
 * driver's when there is one, because a person at the yard signed it; every
 * other copy points at it through `Ticket.duplicateOfTicketId`. The matching
 * engine then counts the load once, compares the copies, and treats a claim on
 * either as a claim on the load.
 *
 * This works whichever copy arrives first: it runs whenever a ticket is read
 * (and when its number or supplier is corrected) and settles the whole group.
 */
import { TicketSource, type Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { numberSearchKey } from './ticket.service.js';

/**
 * Ticket numbers shorter than this are not trusted to identify a load: "12"
 * or "A1" is as likely to be a misread or a line number as a ticket.
 */
export const MIN_COPY_KEY_LENGTH = 3;

/**
 * Two tickets with the same number more than this far apart are taken to be
 * different loads: some scale houses restart their numbering each year. Wide
 * enough that a misread date does not stop two real copies being linked; the
 * engine still flags copies whose dates disagree.
 */
export const COPY_DATE_WINDOW_DAYS = 180;

/** The ticket-number part of the copy key, or null when it cannot identify a load. */
export function ticketCopyKey(ticketNumber: string | null | undefined): string | null {
  const key = numberSearchKey(ticketNumber ?? '');
  return key.length >= MIN_COPY_KEY_LENGTH ? key : null;
}

export interface CopyCandidate {
  id: string;
  source: TicketSource;
  supplierId: string | null;
  ticketNumber: string | null;
  ticketDate: Date | null;
  receivedAt: Date;
  duplicateOfTicketId: string | null;
  poNumber: string | null;
}

/** Whether two tickets with the same number can be the same load, judged by their dates. */
export function withinCopyWindow(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return true;
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000 <= COPY_DATE_WINDOW_DAYS;
}

/**
 * The copy that counts: one that did not come by email (the driver's, or one
 * the office uploaded) before the supplier's own, then the earliest received.
 * The supplier wrote the invoice; a copy the yard holds is the independent one.
 */
export function primaryCopy<T extends Pick<CopyCandidate, 'id' | 'source' | 'receivedAt'>>(copies: readonly T[]): T {
  return [...copies].sort((a, b) => {
    const emailed = Number(a.source === TicketSource.EMAIL) - Number(b.source === TicketSource.EMAIL);
    if (emailed !== 0) return emailed;
    const received = a.receivedAt.getTime() - b.receivedAt.getTime();
    if (received !== 0) return received;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0]!;
}

/**
 * What each ticket in a group should point at: null for the copy that counts,
 * its id for every other copy. Pure, so the rule is tested without a database.
 */
export function plannedLinks(group: readonly CopyCandidate[]): Map<string, string | null> {
  const plan = new Map<string, string | null>();
  if (group.length === 0) return plan;
  if (group.length === 1) {
    plan.set(group[0]!.id, null);
    return plan;
  }
  const primary = primaryCopy(group);
  for (const ticket of group) plan.set(ticket.id, ticket.id === primary.id ? null : primary.id);
  return plan;
}

const COPY_SELECT = {
  id: true,
  source: true,
  supplierId: true,
  ticketNumber: true,
  ticketDate: true,
  receivedAt: true,
  duplicateOfTicketId: true,
  poNumber: true,
} as const;

export interface CopyLinkOutcome {
  /** The copy that counts for this load, or null when the ticket stands alone. */
  primaryId: string | null;
  /** Every ticket in the group, this one included. */
  ticketIds: string[];
  /** Whether any link was written or removed. */
  changed: boolean;
  /** POs of every ticket whose link changed, so their invoice lines are re-checked. */
  poNumbers: string[];
}

/**
 * Links this ticket with every other copy of its load, or unlinks it when it
 * no longer is one (its number was corrected, say). Copies that pointed at it
 * and no longer match are released too.
 */
export async function linkTicketCopies(
  ticketId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma
): Promise<CopyLinkOutcome> {
  const ticket = await db.ticket.findUnique({ where: { id: ticketId }, select: COPY_SELECT });
  if (!ticket) return { primaryId: null, ticketIds: [], changed: false, poNumbers: [] };

  const key = ticketCopyKey(ticket.ticketNumber);
  let group: CopyCandidate[] = [ticket];
  if (key && ticket.supplierId) {
    // The stored key is "ticket|po" (migration 20260915120000); the ticket
    // part is what identifies a load. The PO is compared later, as evidence.
    const others = await db.ticket.findMany({
      where: {
        id: { not: ticket.id },
        supplierId: ticket.supplierId,
        numberSearchKey: { startsWith: `${key}|` },
      },
      select: COPY_SELECT,
      take: 20,
    });
    group = [ticket, ...others.filter((other) => withinCopyWindow(other.ticketDate, ticket.ticketDate))];
  }

  const plan = plannedLinks(group);

  // Copies that pointed at this ticket but are no longer in its group: their
  // copy that counted is gone, so each stands alone until it is read again.
  const stranded = await db.ticket.findMany({
    where: { duplicateOfTicketId: ticket.id, id: { notIn: group.map((copy) => copy.id) } },
    select: COPY_SELECT,
  });
  for (const orphan of stranded) plan.set(orphan.id, null);

  const everyone = new Map<string, CopyCandidate>([...group, ...stranded].map((copy) => [copy.id, copy]));
  const poNumbers = new Set<string>();
  let changed = false;
  for (const [id, target] of plan) {
    const current = everyone.get(id)!;
    if (current.duplicateOfTicketId === target) continue;
    await db.ticket.update({ where: { id }, data: { duplicateOfTicketId: target } });
    changed = true;
    if (current.poNumber) poNumbers.add(current.poNumber);
  }
  // The ticket just read changes its own PO's picture whether or not a link moved.
  if (changed && ticket.poNumber) poNumbers.add(ticket.poNumber);

  const primaryId = group.length > 1 ? primaryCopy(group).id : null;
  if (changed && primaryId) {
    console.log(`[Tickets] Ticket ${ticketId}: ${group.length} copies of one load; ${primaryId} counts.`);
  }
  return { primaryId, ticketIds: group.map((copy) => copy.id), changed, poNumbers: [...poNumbers] };
}
