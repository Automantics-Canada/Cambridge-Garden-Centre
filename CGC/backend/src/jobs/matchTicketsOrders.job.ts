import cron from 'node-cron';
import { prisma } from '../db/prisma.js';
import { matchTicketById } from '../modules/matching/matching.service.js';
import { buildInfo } from '../config/buildInfo.js';

/**
 * A periodic sweep that re-asks the engine about tickets nobody has settled.
 *
 * This job used to be a second matching system. It linked a ticket to an order
 * on PO plus driver alone — no supplier, no product, no quantity — and ran
 * every minute, so the ticket list and the verification desk routinely
 * disagreed about the same ticket, and a ticket with no driver (email, WhatsApp
 * or a manual upload) was never linked however cleanly it matched. All of that
 * bespoke logic is gone: the engine decides, `matchTicketById` writes both the
 * verdict and the link, and this only decides *when* to ask.
 *
 * `driverId` is deliberately not part of matching. Which driver carried a load
 * is a dispatch fact; whether the load was ordered is a question about the PO,
 * the supplier, the product and the quantity, and a driver who happened to be
 * assigned something else is no reason to refuse an otherwise exact match.
 *
 * Re-asking is safe for a ticket that is already linked. The engine relinks one
 * whose PO now names a different single order, and takes a link away only on
 * CONFLICT or UNMATCHED — where several orders fit, or none does. A PARTIAL
 * keeps its link and shows the discrepancy on the desk instead, because a link
 * records which delivery a load was and commits no money. On a rule that
 * unlinked every PARTIAL, the first sweep after a deploy would detach most of
 * the yard's correct deliveries over product wording nobody has aliased yet.
 *
 * Five minutes rather than one. The real triggers are OCR completing and an
 * order import landing, both of which recompute immediately; this is the net
 * under them, and a net does not need to be checked sixty times an hour.
 */

/** Tickets touched per sweep. A backlog is drained over several runs. */
const BATCH_SIZE = 200;

export const startMatchTicketsOrdersJob = () => {
  cron.schedule('*/5 * * * *', async () => {
    try {
      const tickets = await prisma.ticket.findMany({
        where: {
          // Never re-decide something a person has settled. `persist` refuses
          // it anyway; this keeps the batch for tickets that can still change.
          OR: [{ matchResult: null }, { matchResult: { resolution: null } }],
          // Unlinked tickets are the ones waiting for an answer. Auto-linked
          // ones are re-verified because the order behind the link can be
          // corrected or re-imported after the link was made. A manual link is
          // somebody's decision and is left alone.
          AND: [{ OR: [{ status: 'UNLINKED' }, { linkMethod: 'AUTO' }] }],
        },
        select: { id: true },
        // Newest first. A permanent backlog of tickets nothing will ever match
        // must not crowd out the ticket that arrived this morning; the POs that
        // genuinely became matchable are recomputed directly by the import that
        // made them so, not by waiting for this sweep to reach them.
        orderBy: { receivedAt: 'desc' },
        take: BATCH_SIZE,
      });

      // Logged on every sweep, the empty ones included, and stamped with the
      // build. Which code this cron is running is otherwise invisible: the
      // worker service has no HTTP surface, and the version of this job that
      // preceded it announced itself with a different line entirely. So the
      // wording of this line, and the commit in it, is what tells somebody
      // reading Railway logs whether the worker is on the deploy they expect.
      console.log(
        `[Cron] Ticket sweep (build ${buildInfo.commit}): ${tickets.length} unsettled ticket(s).`
      );

      if (tickets.length === 0) return;
      for (const ticket of tickets) {
        try {
          await matchTicketById(ticket.id);
        } catch (error) {
          // One unreadable row must not stop the sweep for the rest.
          console.error(`[Cron] Could not evaluate ticket ${ticket.id}:`, error);
        }
      }
    } catch (error) {
      console.error('[Cron] Ticket-Order Match Job failed:', error);
    }
  });
};
