import { prisma } from '../../db/prisma.js';
import { DeliveryStatus } from '@prisma/client';
import supabaseStorage from '../../services/supabaseStorage.js';
import { saveTicketImage } from '../../services/fileStorage.js';

export const DeliveriesService = {
  async getDeliveries(filters: any) {
    return prisma.delivery.findMany({
      where: filters,
      include: {
        driver: true,
        order: {
          include: {
            supplier: true,
            tickets: true
          }
        },
        history: {
          orderBy: { createdAt: 'desc' }
        }
      },
      orderBy: {
        priority: 'asc'
      }
    });
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
        include: {
          driver: true,
          order: {
            include: {
              supplier: true,
              tickets: true
            }
          },
          history: {
            orderBy: { createdAt: 'desc' }
          }
        }
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
        include: {
          driver: true,
          order: {
            include: {
              supplier: true,
              tickets: true
            }
          },
          history: {
            orderBy: { createdAt: 'desc' }
          }
        }
      });
    } else {
      const uploadResult = await supabaseStorage.uploadTicketImage(fileBuffer, `${id}-${type}`, filename);
      const updateData = type === 'pickup' ? { pickupPhotoUrl: uploadResult.publicUrl } : { deliveryPhotoUrl: uploadResult.publicUrl };

      return prisma.delivery.update({
        where: { id },
        data: updateData,
        include: {
          driver: true,
          order: {
            include: {
              supplier: true,
              tickets: true
            }
          },
          history: {
            orderBy: { createdAt: 'desc' }
          }
        }
      });
    }
  }
};
