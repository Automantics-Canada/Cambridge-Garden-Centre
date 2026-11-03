import { prisma } from '../../db/prisma.js';
import {
  AuditActionType,
  AuditEntityType,
  MatchResolution,
  MatchSubjectType,
  TicketStatus,
  type Prisma,
} from '@prisma/client';
import { haulCandidates } from './haulMatch.js';

/**
 * A person settling a match verdict.
 *
 * The engine can get as far as "these two orders both fit" or "this is 6%
 * short". It cannot get further, and it must not pretend to: choosing between
 * two customers' orders, or accepting a short load, is a decision about money
 * that belongs to whoever is accountable for it.
 *
 * Three ways to settle one:
 *
 *   CONFIRMED   the verdict stands. On a PARTIAL that means "I have seen the
 *               discrepancy and I accept it", which is why a note is worth
 *               having even though it is not demanded.
 *   OVERRIDDEN  the right order is this other one. Requires naming it, and
 *               requires a reason, because the engine disagreed.
 *   REJECTED    nothing on file backs this. Requires a reason.
 *
 * Two properties this is built around:
 *
 *   - **It takes effect.** A resolution is not a sticker on a verdict; it
 *     writes the operational link too, so the ticket really is attached to the
 *     order the person chose. A decision that changed nothing would be worse
 *     than none, because the screen would say it had been handled.
 *   - **It is one transaction.** The verdict, the link and the audit entry land
 *     together or not at all. A half-applied resolution would leave a ticket
 *     attached to an order with no record of who attached it.
 */

export type ResolutionInput = 'CONFIRMED' | 'OVERRIDDEN' | 'REJECTED';

/**
 * These tickets and every other copy of their loads: the copy each points at,
 * and the copies pointing at those. Copies are linked one level deep (every
 * copy points straight at the one that counts), so two reads find them all.
 */
async function copiesOf(tx: Prisma.TransactionClient, ticketIds: readonly string[]): Promise<string[]> {
  if (ticketIds.length === 0) return [];
  const own = await tx.ticket.findMany({
    where: { id: { in: [...ticketIds] } },
    select: { id: true, duplicateOfTicketId: true },
  });
  const roots = [...new Set(own.map((ticket) => ticket.duplicateOfTicketId ?? ticket.id))];
  const copies = await tx.ticket.findMany({
    where: { OR: [{ id: { in: roots } }, { duplicateOfTicketId: { in: roots } }] },
    select: { id: true },
  });
  return [...new Set([...ticketIds, ...copies.map((ticket) => ticket.id)])];
}

export type ResolveFailure =
  | { ok: false; code: 'NOT_FOUND' }
  | { ok: false; code: 'TICKETS_ALREADY_CLAIMED'; detail: string }
  | { ok: false; code: 'LOAD_ALREADY_CLAIMED'; detail: string }
  | { ok: false; code: 'LOAD_CHOICE_REQUIRED'; detail: string }
  | { ok: false; code: 'NOTE_REQUIRED_DUPLICATE'; detail: string }
  | { ok: false; code: 'ALREADY_RESOLVED'; resolvedAt: Date | null }
  | { ok: false; code: 'ORDER_REQUIRED' }
  | { ok: false; code: 'NOTE_REQUIRED' }
  | { ok: false; code: 'ORDER_NOT_FOUND' };

export type ResolveResult = { ok: true; matchResultId: string } | ResolveFailure;

/**
 * Why a note is demanded for two of the three.
 *
 * CONFIRMED agrees with reasoning that is already stored, so the evidence
 * explains itself. OVERRIDDEN and REJECTED contradict it, and six months later
 * the only record of why will be whatever the person typed here.
 */
function noteRequired(resolution: ResolutionInput): boolean {
  return resolution !== 'CONFIRMED';
}

/**
 * Thrown inside the transaction when a load this decision would pay has been
 * paid by another line, or removed from the board, since the verdict was
 * computed. Rolls the whole decision back.
 */
class LoadClaimConflict extends Error {}

/**
 * The loads an override pays: the haul of the chosen order that this carrier
 * hauled. The verdict's own loads when they are on that order; otherwise the
 * order's loads by this carrier, grouped the way the matcher groups them
 * (a trip is one haul, a day at a time), leaving out hauls another line paid.
 * Null when the order had more than one such haul and nothing says which.
 */
async function overrideLoadIds(
  orderId: string,
  carrierSupplierId: string,
  verdictLoadIds: string[],
  invoiceLineId: string
): Promise<string[] | null> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { documentId: true } });
  if (!order?.documentId) return [];
  const documentId = order.documentId;

  if (verdictLoadIds.length > 0) {
    const onOrder = await prisma.dispatchLoad.count({ where: { id: { in: verdictLoadIds }, documentId } });
    if (onOrder > 0) return verdictLoadIds;
  }

  const own = await prisma.dispatchLoad.findMany({
    where: { documentId, carrierSupplierId },
    select: { tripRef: true },
  });
  if (own.length === 0) return [];
  // A trip's other loads are on other orders: read them too, so the trip is
  // claimed whole.
  const trips = [...new Set(own.flatMap((load) => (load.tripRef ? [load.tripRef] : [])))];
  const { loadCandidateLoads } = await import('./matching.service.js');
  const loads = await loadCandidateLoads({
    carrierSupplierId,
    OR: [{ documentId }, ...(trips.length > 0 ? [{ tripRef: { in: trips } }] : [])],
  });
  const hauls = haulCandidates(loads, carrierSupplierId, null, 0).filter(
    (candidate) =>
      candidate.haul.documentIds.includes(documentId) &&
      candidate.loads.every((load) => load.claimedByLineItemId === null || load.claimedByLineItemId === invoiceLineId)
  );
  if (hauls.length === 1) return hauls[0]!.haul.loadIds;
  return hauls.length === 0 ? [] : null;
}

export async function resolveMatchResult(params: {
  matchResultId: string;
  resolution: ResolutionInput;
  orderId?: string | null;
  note?: string | null;
  userId: string;
}): Promise<ResolveResult> {
  const { matchResultId, resolution, userId } = params;
  const note = params.note?.trim() || null;
  const orderId = params.orderId?.trim() || null;

  const existing = await prisma.matchResult.findUnique({
    where: { id: matchResultId },
    select: {
      id: true,
      subjectType: true,
      ticketId: true,
      invoiceLineId: true,
      orderId: true,
      status: true,
      resolution: true,
      resolvedAt: true,
      ticketIds: true,
      loadIds: true,
      evidence: true,
      // Which PO this decision changes the picture for; see the recompute
      // after the transaction below.
      ticket: { select: { poNumber: true } },
      invoiceLine: {
        select: {
          poNumber: true,
          // A trucking company's line pays dispatch loads, not tickets.
          invoice: { select: { supplierId: true, supplier: { select: { type: true } } } },
        },
      },
    },
  });

  if (!existing) return { ok: false, code: 'NOT_FOUND' };

  // A settled verdict is reopened deliberately, never overwritten in passing.
  if (existing.resolution) {
    return { ok: false, code: 'ALREADY_RESOLVED', resolvedAt: existing.resolvedAt };
  }

  if (resolution === 'OVERRIDDEN' && !orderId) return { ok: false, code: 'ORDER_REQUIRED' };
  if (noteRequired(resolution) && !note) return { ok: false, code: 'NOTE_REQUIRED' };

  // Two gates that only apply when this resolution commits money.
  //
  // The evidence already says these loads were paid for elsewhere, or that
  // another unreviewed invoice bills the same PO. Letting Confirm through
  // anyway would make the check decorative — one click and the same delivery
  // is paid twice, which is the failure this whole feature exists to stop.
  const commits = resolution === 'CONFIRMED' || resolution === 'OVERRIDDEN';
  if (commits && existing.subjectType === MatchSubjectType.INVOICE_LINE) {
    const checks = Array.isArray(existing.evidence)
      ? (existing.evidence as Array<{ name?: string; passed?: boolean; detail?: string }>)
      : [];

    // A haul another invoice has paid is never paid again (haulMatch.ts).
    const paidHaul = checks.find((check) => check.name === 'loadReuse' && check.passed === false);
    if (paidHaul) {
      return {
        ok: false,
        code: 'LOAD_ALREADY_CLAIMED',
        detail: paidHaul.detail ?? 'This haul has already been paid on another invoice.',
      };
    }

    const reuse = checks.find((check) => check.name === 'ticketReuse' && check.passed === false);
    if (reuse) {
      return {
        ok: false,
        code: 'TICKETS_ALREADY_CLAIMED',
        detail:
          reuse.detail ??
          'These tickets have already been used to pay another invoice line.',
      };
    }

    const contested = checks.find(
      (check) => check.name === 'duplicateBilling' && check.passed === false
    );
    if (contested && !note) {
      return {
        ok: false,
        code: 'NOTE_REQUIRED_DUPLICATE',
        detail: contested.detail ?? 'Another unreviewed invoice bills this PO.',
      };
    }
  }

  // The order the link will point at afterwards. A rejection points at nothing;
  // an override points where the person said; a confirmation keeps what the
  // engine found.
  const targetOrderId =
    resolution === 'REJECTED' ? null : resolution === 'OVERRIDDEN' ? orderId : existing.orderId;

  if (targetOrderId) {
    const order = await prisma.order.findUnique({
      where: { id: targetOrderId },
      select: { id: true },
    });
    if (!order) return { ok: false, code: 'ORDER_NOT_FOUND' };
  }

  // The dispatch loads a trucking line's decision pays (Q14). Claimed on
  // DispatchLoad, never through TicketClaim: one scale ticket can rightly back
  // both the pit's material line and the trucker's haul line.
  const carrierSupplierId =
    existing.invoiceLine?.invoice.supplier.type === 'TRUCKING_COMPANY'
      ? existing.invoiceLine.invoice.supplierId
      : null;
  let loadIds: string[] = [];
  if (commits && carrierSupplierId && existing.invoiceLineId) {
    if (resolution === 'CONFIRMED') {
      // Confirming a CONFLICT would pay a line without saying which haul it
      // was, and leave that haul free to be paid again.
      if (existing.status === 'CONFLICT') {
        return {
          ok: false,
          code: 'LOAD_CHOICE_REQUIRED',
          detail: 'Several dispatched loads fit this line. Use Override and choose the order this haul was for.',
        };
      }
      loadIds = existing.loadIds;
    } else if (targetOrderId) {
      const chosen = await overrideLoadIds(targetOrderId, carrierSupplierId, existing.loadIds, existing.invoiceLineId);
      if (chosen === null) {
        return {
          ok: false,
          code: 'LOAD_CHOICE_REQUIRED',
          detail:
            'That order has more than one load by this carrier, and nothing says which one this line bills. ' +
            'Put the ticket number on the right load on the dispatch board, then re-run the check.',
        };
      }
      loadIds = chosen;
    }
  }

  let claimedTicketIds: string[] = [];
  try {
  await prisma.$transaction(async (tx) => {
    await tx.matchResult.update({
      where: { id: matchResultId },
      data: {
        resolution: resolution as MatchResolution,
        resolutionNote: note,
        resolvedById: userId,
        resolvedAt: new Date(),
        ...(resolution === 'OVERRIDDEN' ? { orderId: targetOrderId } : {}),
      },
    });

    if (existing.subjectType === MatchSubjectType.TICKET && existing.ticketId) {
      const ticketId = existing.ticketId;

      if (targetOrderId) {
        await tx.ticketOrderMatch.upsert({
          where: { ticketId_orderId: { ticketId, orderId: targetOrderId } },
          create: {
            ticketId,
            orderId: targetOrderId,
            // Recorded as a person's decision, never as an automatic match. The
            // distinction is the whole reason this column exists.
            matchMethod: resolution === 'OVERRIDDEN' ? 'HUMAN_OVERRIDE' : 'HUMAN_CONFIRMED',
            createdBy: userId,
          },
          update: { createdBy: userId },
        });

        await tx.ticket.update({
          where: { id: ticketId },
          data: {
            linkedOrderId: targetOrderId,
            linkMethod: 'MANUAL',
            linkedById: userId,
            status: TicketStatus.LINKED,
          },
        });
      } else {
        // Rejected: detach, and say so on the ticket rather than leaving it
        // pointing at an order a person has just said is wrong.
        if (existing.orderId) {
          await tx.ticketOrderMatch.deleteMany({
            where: { ticketId, orderId: existing.orderId },
          });
        }
        await tx.ticket.update({
          where: { id: ticketId },
          data: {
            linkedOrderId: null,
            linkedById: userId,
            status: TicketStatus.UNLINKED,
          },
        });
      }
    }

    if (existing.subjectType === MatchSubjectType.INVOICE_LINE && existing.invoiceLineId) {
      const invoiceLineId = existing.invoiceLineId;

      // Claim, or release, the loads this decision pays for.
      //
      // This is the moment money is committed, so it is the only moment a
      // ticket becomes spent. The claim is on exactly what the verdict counted
      // (`ticketIds`), not on whatever carries the PO now — a load photographed
      // after the verdict was computed was never part of what anyone approved.
      if (targetOrderId) {
        // Every copy of each load is claimed with it: the driver's photo and
        // the supplier's emailed copy of one ticket are one load (A15). A
        // copy already claimed for another line trips the unique constraint
        // below, which is the load being paid twice.
        claimedTicketIds = await copiesOf(tx, existing.ticketIds);
        for (const ticketId of claimedTicketIds) {
          await tx.ticketClaim.create({
            data: { ticketId, invoiceLineId, matchResultId, claimedById: userId },
          });
        }
      } else {
        // Rejected: the loads go back in the pot for whichever invoice really
        // covers them. Without this a rejected duplicate would block the real
        // invoice permanently.
        await tx.ticketClaim.deleteMany({ where: { invoiceLineId } });
      }

      if (carrierSupplierId) {
        if (commits) {
          // Claimed only if still unpaid, re-checked here inside the
          // transaction: two invoices confirmed at the same moment cannot both
          // pay one load. The second waits on the first's row lock, then finds
          // the load taken and rolls back.
          if (loadIds.length > 0) {
            const claimed = await tx.dispatchLoad.updateMany({
              where: {
                id: { in: loadIds },
                OR: [{ claimedByLineItemId: null }, { claimedByLineItemId: invoiceLineId }],
              },
              data: { claimedByLineItemId: invoiceLineId, claimedAt: new Date() },
            });
            if (claimed.count !== loadIds.length) throw new LoadClaimConflict();
          }
          // What the person chose is what this line now holds.
          if (resolution === 'OVERRIDDEN') {
            await tx.matchResult.update({ where: { id: matchResultId }, data: { loadIds } });
          }
        } else {
          // Rejected: the haul is free for whichever invoice really bills it.
          await tx.dispatchLoad.updateMany({
            where: { claimedByLineItemId: invoiceLineId },
            data: { claimedByLineItemId: null, claimedAt: null },
          });
        }
      }

      await tx.invoiceLineItem.update({
        where: { id: existing.invoiceLineId },
        data: {
          matchedOrderId: targetOrderId,
          isOverridden: resolution === 'OVERRIDDEN',
          ...(note ? { overrideNote: note } : {}),
        },
      });
    }

    await tx.auditLog.create({
      data: {
        entityType:
          existing.subjectType === MatchSubjectType.TICKET
            ? AuditEntityType.TICKET
            : AuditEntityType.INVOICE,
        entityId: existing.ticketId ?? existing.invoiceLineId ?? matchResultId,
        actionType: AuditActionType.MATCH_RESOLVED,
        performedById: userId,
        details: {
          matchResultId,
          resolution,
          note,
          // Both, so a later reader can see what the engine had concluded and
          // what the person decided instead.
          engineStatus: existing.status,
          engineOrderId: existing.orderId,
          resolvedOrderId: targetOrderId,
          claimedTicketIds: targetOrderId ? claimedTicketIds : [],
          ...(carrierSupplierId ? { claimedLoadIds: commits ? loadIds : [] } : {}),
        },
      },
    });
  });

  } catch (error) {
    if (error instanceof LoadClaimConflict) {
      return {
        ok: false,
        code: 'LOAD_ALREADY_CLAIMED',
        detail:
          'Somebody paid this haul on another invoice, or it was removed from the dispatch board, while you were deciding. Reload and look again.',
      };
    }
    // Two clerks confirming competing lines at the same moment: the unique
    // constraint on TicketClaim.ticketId is the last line of defence, and it
    // holds even when both requests passed their checks a moment earlier.
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'P2002'
    ) {
      return {
        ok: false,
        code: 'TICKETS_ALREADY_CLAIMED',
        detail:
          'Somebody claimed one of these tickets for another invoice line while you were deciding. Reload and look again.',
      };
    }
    throw error;
  }

  // What this decision changed for everything else on the same PO.
  //
  // Confirming a line spends its loads, so a competing line that read "matched"
  // a second ago is now billing tickets that are gone; rejecting one hands them
  // back. Contention is derived, not stored, so the only way the other lines
  // learn about it is by being asked again. Outside the transaction and
  // best-effort: the decision above has committed and stands regardless.
  const poNumber = existing.ticket?.poNumber ?? existing.invoiceLine?.poNumber ?? null;
  if (poNumber) {
    const { recomputeInvoiceLinesSafely } = await import('./matching.service.js');
    await recomputeInvoiceLinesSafely([poNumber], `resolution of ${matchResultId}`);
  }
  // A haul paid or released changes what the carrier's other open lines can
  // claim, whatever PO they print.
  if (carrierSupplierId) {
    await recomputeCarrierLinesSafely(carrierSupplierId, `resolution of ${matchResultId}`);
  }

  return { ok: true, matchResultId };
}

/** Bound on the carrier's open lines re-decided after a haul changes hands. */
const CARRIER_RECOMPUTE_LIMIT = 200;

/**
 * Re-decides a trucking company's open invoice lines. Best-effort, outside
 * the decision's transaction, like the PO recompute: the decision stands
 * whatever happens here.
 */
async function recomputeCarrierLinesSafely(carrierSupplierId: string, context: string): Promise<void> {
  try {
    const { recomputeInvoiceLinesForSupplier } = await import('./matching.service.js');
    const outcome = await recomputeInvoiceLinesForSupplier(carrierSupplierId, CARRIER_RECOMPUTE_LIMIT);
    console.log(`[Matching] ${context}: recomputed ${outcome.lines} haul line(s) for the carrier.`);
  } catch (error) {
    console.error(`[Matching] ${context}: haul line recompute failed:`, error);
  }
}

/**
 * Reopens a settled verdict so it can be decided again.
 *
 * The stored verdict and its evidence are left alone: what the engine concluded
 * has not changed, only whether a person still stands behind their answer. The
 * next matching run will refresh it, because it is no longer resolved.
 */
export async function reopenMatchResult(params: {
  matchResultId: string;
  note?: string | null;
  userId: string;
  /**
   * Whether to re-decide the other unsettled lines on this PO afterwards.
   *
   * Defaults to true, which is what somebody reopening one verdict wants: the
   * loads it was holding are free again and the competing lines need to know.
   * The one caller that passes false is re-extracting an invoice, where every
   * line being reopened is about to be deleted and the lines replacing them are
   * decided a moment later.
   */
  recomputeOthers?: boolean;
}): Promise<ResolveResult> {
  const note = params.note?.trim() || null;

  const existing = await prisma.matchResult.findUnique({
    where: { id: params.matchResultId },
    select: {
      id: true,
      subjectType: true,
      ticketId: true,
      invoiceLineId: true,
      resolution: true,
      ticket: { select: { poNumber: true } },
      invoiceLine: {
        select: { poNumber: true, invoice: { select: { supplierId: true, supplier: { select: { type: true } } } } },
      },
    },
  });

  if (!existing) return { ok: false, code: 'NOT_FOUND' };
  if (!existing.resolution) return { ok: true, matchResultId: existing.id };
  const carrierSupplierId =
    existing.invoiceLine?.invoice.supplier.type === 'TRUCKING_COMPANY'
      ? existing.invoiceLine.invoice.supplierId
      : null;

  await prisma.$transaction(async (tx) => {
    await tx.matchResult.update({
      where: { id: params.matchResultId },
      data: {
        resolution: null,
        resolutionNote: null,
        resolvedById: null,
        resolvedAt: null,
      },
    });

    // Reopening un-commits the money, so the loads are no longer spent: the
    // tickets of a material line, and the dispatch loads of a haul line.
    if (existing.invoiceLineId) {
      await tx.ticketClaim.deleteMany({ where: { invoiceLineId: existing.invoiceLineId } });
      await tx.dispatchLoad.updateMany({
        where: { claimedByLineItemId: existing.invoiceLineId },
        data: { claimedByLineItemId: null, claimedAt: null },
      });
    }

    await tx.auditLog.create({
      data: {
        entityType:
          existing.subjectType === MatchSubjectType.TICKET
            ? AuditEntityType.TICKET
            : AuditEntityType.INVOICE,
        entityId: existing.ticketId ?? existing.invoiceLineId ?? params.matchResultId,
        actionType: AuditActionType.MATCH_REOPENED,
        performedById: params.userId,
        details: { matchResultId: params.matchResultId, note, previous: existing.resolution },
      },
    });
  });

  // Reopening released this line's loads, so every other unsettled line on the
  // PO has more to work with than it did a moment ago — including this one,
  // which is unresolved again and so gets a fresh verdict here.
  const poNumber = existing.ticket?.poNumber ?? existing.invoiceLine?.poNumber ?? null;
  if (poNumber && params.recomputeOthers !== false) {
    const { recomputeInvoiceLinesSafely } = await import('./matching.service.js');
    await recomputeInvoiceLinesSafely([poNumber], `reopening of ${existing.id}`);
  }
  if (carrierSupplierId && params.recomputeOthers !== false) {
    await recomputeCarrierLinesSafely(carrierSupplierId, `reopening of ${existing.id}`);
  }

  return { ok: true, matchResultId: existing.id };
}
