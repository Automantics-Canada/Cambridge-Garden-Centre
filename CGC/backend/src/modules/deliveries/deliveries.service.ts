import { prisma } from '../../db/prisma.js';
import { DeliveryStatus } from '@prisma/client';
import supabaseStorage from '../../services/supabaseStorage.js';
import { DISPATCH_DOCUMENT_SELECT } from '../dispatch/dispatchOrderView.js';
import { saveTicketImage } from '../../services/fileStorage.js';

/**
 * The delivery list/detail shape rendered by operations screens, and what
 * every delivery write answers with.
 *
 * Drivers call the status and photo routes, so their answers must never carry
 * more than this. They once returned the whole order line with its supplier,
 * which since the Spruce import includes unit price and unit cost — figures a
 * driver must not see.
 */
export const DELIVERY_RESPONSE_SELECT = {
  id: true,
  orderId: true,
  driverId: true,
  priority: true,
  status: true,
  pickupPhotoUrl: true,
  deliveryPhotoUrl: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  driver: { select: { id: true, name: true } },
  /** The whole Spruce order this stop delivers; null on stops made before. */
  document: { select: DISPATCH_DOCUMENT_SELECT },
  order: {
    select: {
      id: true,
      spruceOrderId: true,
      customerName: true,
      product: true,
      quantity: true,
      unit: true,
    },
  },
  history: {
    select: { id: true, status: true, notes: true, createdAt: true },
    orderBy: { createdAt: 'desc' as const },
  },
} as const;

/** Extra order evidence needed only by the driver's current-stop screen. */
export const DELIVERY_DRIVER_RESPONSE_SELECT = {
  ...DELIVERY_RESPONSE_SELECT,
  order: {
    select: {
      ...DELIVERY_RESPONSE_SELECT.order.select,
      document: {
        select: { shippingAddress: true },
      },
      tickets: {
        select: {
          id: true,
          ticketNumber: true,
          imageUrl: true,
          thumbnailUrl: true,
          status: true,
          driverId: true,
        },
      },
    },
  },
} as const;

/** A stop in either state is history: never a driver's current stop. */
const FINISHED: DeliveryStatus[] = [DeliveryStatus.DELIVERED, DeliveryStatus.CANCELLED];

/**
 * The order a driver works through their run: dispatch's priority, then the
 * older stop, then a fixed tie-break, so two reads never disagree about which
 * stop is current.
 */
const RUN_ORDER = [{ priority: 'asc' as const }, { createdAt: 'asc' as const }, { id: 'asc' as const }];

/** Under way: the truck is loaded for this stop. */
const STARTED: DeliveryStatus[] = [DeliveryStatus.OUT_FOR_DELIVERY, DeliveryStatus.IN_TRANSIT];

export class DeliveryNotCurrentError extends Error {
  readonly code = 'DELIVERY_NOT_CURRENT';
}

/**
 * The stop a driver is on: one already under way if there is one, otherwise
 * the next by dispatch's order.
 *
 * Dispatch reorders runs all day as customers call. That decides what comes
 * next, never what is already on the truck: a driver halfway to one customer
 * must not find their screen showing another.
 */
async function currentStopId(driverId: string): Promise<string | null> {
  const started = await prisma.delivery.findFirst({
    where: { driverId, status: { in: STARTED } },
    orderBy: RUN_ORDER,
    select: { id: true },
  });
  if (started) return started.id;

  const next = await prisma.delivery.findFirst({
    where: { driverId, status: { notIn: FINISHED } },
    orderBy: RUN_ORDER,
    select: { id: true },
  });
  return next?.id ?? null;
}

export const DeliveriesService = {
  /**
   * What a driver sees: their current stop and nothing after it, with how many
   * stops remain.
   *
   * Dispatch reorders a run while drivers are out — a customer calls, an order
   * jumps the queue — so the rest of the run is both changing and none of the
   * driver's business. Only the stop in hand leaves the server.
   */
  async getCurrentStop(driverId: string) {
    const [id, remaining] = await Promise.all([
      currentStopId(driverId),
      prisma.delivery.count({ where: { driverId, status: { notIn: FINISHED } } }),
    ]);
    const current = id
      ? await prisma.delivery.findUnique({ where: { id }, select: DELIVERY_DRIVER_RESPONSE_SELECT })
      : null;

    return {
      data: current ? [current] : [],
      pagination: { page: 1, limit: 1, totalCount: remaining, totalPages: 1 },
    };
  },

  /**
   * Refuses a driver's change to any stop but their current one. The screen
   * only ever shows the current stop; this makes that the rule rather than a
   * habit of the screen.
   */
  async assertCurrentStop(driverId: string, deliveryId: string) {
    if ((await currentStopId(driverId)) !== deliveryId) {
      throw new DeliveryNotCurrentError(
        'This is not your current stop. Finish the one on your screen first; dispatch sets the order.'
      );
    }
  },

  async getDeliveries(
    filters: any,
    page = 1,
    limit = 50,
    sort: 'priority' | 'newest' = 'priority',
    audience: 'operations' | 'driver' = 'operations',
  ) {
    const take = Math.min(Math.max(limit, 1), 100);
    const skip = (Math.max(page, 1) - 1) * take;
    const [data, totalCount] = await Promise.all([
      prisma.delivery.findMany({
        where: filters,
        select: audience === 'driver' ? DELIVERY_DRIVER_RESPONSE_SELECT : DELIVERY_RESPONSE_SELECT,
        orderBy: sort === 'newest'
          ? [{ createdAt: 'desc' }, { id: 'asc' }]
          : [{ priority: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      prisma.delivery.count({ where: filters }),
    ]);

    return {
      data,
      pagination: {
        page: Math.max(page, 1),
        limit: take,
        totalCount,
        totalPages: Math.max(1, Math.ceil(totalCount / take)),
      },
    };
  },

  /**
   * Applies a status change that the controller has already authorised.
   *
   * `expectedFrom` is the status the caller validated against. The write is
   * conditional on the row still holding it, so two concurrent requests cannot
   * both pass validation and then both apply — the loser gets a conflict
   * instead of silently overwriting.
   *
   * History and the delivery row move together in one transaction. Previously
   * the history row was created first and separately, so a failed update left
   * an audit entry for a change that never happened.
   */
  async updateStatus(
    id: string,
    status: DeliveryStatus,
    notes?: string,
    expectedFrom?: DeliveryStatus
  ) {
    return prisma.$transaction(async (tx) => {
      const delivery = await tx.delivery.findUnique({ where: { id } });
      if (!delivery) throw new Error('Delivery not found');

      const updateData: any = { status };
      if (status === 'IN_TRANSIT' && !delivery.startedAt) {
        updateData.startedAt = new Date();
      } else if (status === 'DELIVERED') {
        updateData.completedAt = new Date();
      }

      // Optimistic concurrency: only write if the row is still in the state the
      // transition was validated against.
      if (expectedFrom !== undefined) {
        const claimed = await tx.delivery.updateMany({
          where: { id, status: expectedFrom },
          data: updateData,
        });
        if (claimed.count === 0) {
          const conflict: any = new Error(
            `Delivery is no longer ${expectedFrom}; refresh and retry`
          );
          conflict.code = 'DELIVERY_TRANSITION_CONFLICT';
          throw conflict;
        }
      } else {
        await tx.delivery.update({ where: { id }, data: updateData });
      }

      await tx.deliveryHistory.create({
        data: {
          deliveryId: id,
          status,
          notes: notes || `Status updated to ${status}`
        }
      });

      return tx.delivery.findUniqueOrThrow({
        where: { id },
        select: DELIVERY_RESPONSE_SELECT
      });
    });
  },

  async uploadPhoto(id: string, type: 'pickup' | 'delivery' | 'ticket', fileBuffer: Buffer, filename: string) {
    if (type === 'ticket') {
      const delivery = await prisma.delivery.findUnique({
        where: { id },
        include: { order: true }
      });
      if (!delivery) throw new Error('Delivery not found');

      // Driver-uploaded POD tickets must use the same path as email, WhatsApp,
      // and dashboard uploads so they also receive a best-effort thumbnail.
      const { imageUrl, thumbnailUrl } = await saveTicketImage(fileBuffer, filename);

      // Create a ticket in the database linked to the driver and order
      const ticket = await prisma.ticket.create({
        data: {
          source: 'MANUAL',
          imageUrl,
          thumbnailUrl,
          ocrRawText: '',
          ocrConfidence: 0,
          status: 'LINKED',
          linkMethod: 'MANUAL',
          receivedAt: new Date(),
          driverId: delivery.driverId,
          linkedOrderId: delivery.orderId,
        }
      });

      // Create the TicketOrderMatch junction record
      await prisma.ticketOrderMatch.upsert({
        where: {
          ticketId_orderId: {
            ticketId: ticket.id,
            orderId: delivery.orderId,
          }
        },
        update: {
          matchMethod: 'MANUAL',
        },
        create: {
          ticketId: ticket.id,
          orderId: delivery.orderId,
          matchMethod: 'MANUAL',
        }
      });

      // Create the OCR Job for the ticket
      const ocrJob = await prisma.ocrJob.create({
        data: {
          type: 'TICKET',
          provider: 'AWS_TEXTRACT',
          status: 'PENDING',
          ticketId: ticket.id,
        }
      });

      // Trigger OCR background processing
      const { triggerOcrProcessing } = await import('../../services/ocrJobProcessor.js');
      triggerOcrProcessing(ocrJob.id);

      // Return the delivery fully loaded with order and tickets
      return prisma.delivery.findUnique({
        where: { id },
        select: DELIVERY_RESPONSE_SELECT
      });
    } else {
      const uploadResult = await supabaseStorage.uploadTicketImage(fileBuffer, `${id}-${type}`, filename);
      const updateData = type === 'pickup' ? { pickupPhotoUrl: uploadResult.publicUrl } : { deliveryPhotoUrl: uploadResult.publicUrl };

      return prisma.delivery.update({
        where: { id },
        data: updateData,
        select: DELIVERY_RESPONSE_SELECT
      });
    }
  }
};
