import { prisma } from '../../db/prisma.js';
import {
  AuditActionType,
  AuditEntityType,
  MatchResolution,
  MatchSubjectType,
  TicketStatus,
} from '@prisma/client';

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

export type ResolveFailure =
  | { ok: false; code: 'NOT_FOUND' }
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
    },
  });

  if (!existing) return { ok: false, code: 'NOT_FOUND' };

  // A settled verdict is reopened deliberately, never overwritten in passing.
  if (existing.resolution) {
    return { ok: false, code: 'ALREADY_RESOLVED', resolvedAt: existing.resolvedAt };
  }

  if (resolution === 'OVERRIDDEN' && !orderId) return { ok: false, code: 'ORDER_REQUIRED' };
  if (noteRequired(resolution) && !note) return { ok: false, code: 'NOTE_REQUIRED' };

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
        },
      },
    });
  });

  return { ok: true, matchResultId };
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
}): Promise<ResolveResult> {
  const note = params.note?.trim() || null;

  const existing = await prisma.matchResult.findUnique({
    where: { id: params.matchResultId },
    select: { id: true, subjectType: true, ticketId: true, invoiceLineId: true, resolution: true },
  });

  if (!existing) return { ok: false, code: 'NOT_FOUND' };
  if (!existing.resolution) return { ok: true, matchResultId: existing.id };

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

  return { ok: true, matchResultId: existing.id };
}
