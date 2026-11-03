import type { DeliveryStatus, Prisma } from '@prisma/client';

import { prisma } from '../../db/prisma.js';
import { OrderEditError, dropQuoteFlag } from '../orders/edits/orderEdits.service.js';
import { DISPATCH_DOCUMENT_SELECT, representativeLineId } from './dispatchOrderView.js';

/**
 * "Done outside the app": the office marks an order delivered that went out
 * without a driver using the app.
 *
 * The client (Oct 2026): an order completed in Spruce keeps no delivery date
 * and drops off the Deliveries report, and one delivered before the app saw
 * its report never had a stop at all. Nothing else would ever take such an
 * order off the board's undated list, today's pool or Carried over, so it
 * lingered as work nobody was going to do.
 *
 * The stop is marked DELIVERED with the time, a history note and an audit
 * row; one is made if the order never had a stop. A stop a driver has
 * started is theirs to finish on the phone, and a cancelled one stays
 * cancelled. Marking an order that is already delivered changes nothing.
 * An order flagged a quotation loses the flag: it went out, so it was one.
 */

export class DoneOutsideAppError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** On a truck now: the driver finishes it. */
const STARTED: DeliveryStatus[] = ['OUT_FOR_DELIVERY', 'IN_TRANSIT'];

export const DONE_OUTSIDE_APP_NOTE = 'Done outside the app (marked by the office)';

export interface DoneOutsideAppResult {
  deliveryId: string;
  status: 'DELIVERED';
  completedAt: Date;
  /** False when the order was already delivered and nothing was written. */
  changed: boolean;
}

export async function markDoneOutsideApp(
  documentId: string,
  userId: string,
  now: Date = new Date()
): Promise<DoneOutsideAppResult> {
  return prisma.$transaction(async (tx) => {
    const document = await tx.orderDocument.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        documentNumber: true,
        lines: DISPATCH_DOCUMENT_SELECT.lines,
        delivery: { select: { id: true, status: true, completedAt: true, driverId: true } },
      },
    });
    if (!document) throw new DoneOutsideAppError(404, 'That order no longer exists.');

    const stop = document.delivery;
    if (stop?.status === 'DELIVERED') {
      return { deliveryId: stop.id, status: 'DELIVERED', completedAt: stop.completedAt ?? now, changed: false };
    }
    if (stop?.status === 'CANCELLED') {
      throw new DoneOutsideAppError(409, `${document.documentNumber} was cancelled, so it cannot be marked delivered.`);
    }
    if (stop && STARTED.includes(stop.status)) {
      throw new DoneOutsideAppError(
        409,
        `${document.documentNumber} is on a driver's truck now. The driver finishes it on their phone.`
      );
    }

    let deliveryId: string;
    if (stop) {
      // Conditional on the status read above, so a driver starting the stop
      // at this moment is not overwritten.
      const claimed = await tx.delivery.updateMany({
        where: { id: stop.id, status: stop.status },
        data: { status: 'DELIVERED', completedAt: now },
      });
      if (claimed.count === 0) {
        throw new DoneOutsideAppError(409, `${document.documentNumber} changed just now. Refresh and try again.`);
      }
      deliveryId = stop.id;
    } else {
      const lineId = representativeLineId(document);
      if (!lineId) throw new DoneOutsideAppError(409, `${document.documentNumber} has no lines to deliver.`);
      deliveryId = (await tx.delivery.create({
        data: { documentId, orderId: lineId, status: 'DELIVERED', priority: 1, completedAt: now },
        select: { id: true },
      })).id;
    }

    await tx.deliveryHistory.create({
      data: { deliveryId, status: 'DELIVERED', notes: DONE_OUTSIDE_APP_NOTE },
    });
    await tx.auditLog.create({
      data: {
        entityType: 'ORDER',
        entityId: documentId,
        actionType: 'ORDER_EDITED',
        performedById: userId,
        details: {
          documentNumber: document.documentNumber,
          action: 'DONE_OUTSIDE_APP',
          changes: [{ field: 'deliveryStatus', lineId: null, from: stop?.status ?? null, to: 'DELIVERED' }],
          driverId: stop?.driverId ?? null,
        } as Prisma.InputJsonValue,
      },
    });

    // Delivered is an order, whatever the import took it for: an order the
    // app never saw open can have been flagged a quotation.
    try {
      await dropQuoteFlag(tx, documentId);
    } catch (error) {
      if (error instanceof OrderEditError) throw new DoneOutsideAppError(error.status, error.message);
      throw error;
    }

    return { deliveryId, status: 'DELIVERED', completedAt: now, changed: true };
  });
}
