import { prisma } from '../../db/prisma.js';
import { DeliveryStatus } from '@prisma/client';
import supabaseStorage from '../../services/supabaseStorage.js';

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

  async updateStatus(id: string, status: DeliveryStatus, notes?: string) {
    const delivery = await prisma.delivery.findUnique({ where: { id } });
    if (!delivery) throw new Error('Delivery not found');

    const updateData: any = { status };
    if (status === 'IN_TRANSIT' && !delivery.startedAt) {
      updateData.startedAt = new Date();
    } else if (status === 'DELIVERED') {
      updateData.completedAt = new Date();
    }

    // Record history
    await prisma.deliveryHistory.create({
      data: {
        deliveryId: id,
        status,
        notes: notes || `Status updated to ${status}`
      }
    });

    const updated = await prisma.delivery.update({
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

    return updated;
  },

  async uploadPhoto(id: string, type: 'pickup' | 'delivery' | 'ticket', fileBuffer: Buffer, filename: string) {
    const uploadResult = await supabaseStorage.uploadTicketImage(fileBuffer, `${id}-${type}`, filename);
    
    if (type === 'ticket') {
      const delivery = await prisma.delivery.findUnique({
        where: { id },
        include: { order: true }
      });
      if (!delivery) throw new Error('Delivery not found');

      // Create a ticket in the database linked to the driver and order
      const ticket = await prisma.ticket.create({
        data: {
          source: 'MANUAL',
          imageUrl: uploadResult.publicUrl,
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
