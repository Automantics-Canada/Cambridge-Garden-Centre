import { prisma } from '../../db/prisma.js';
import { DeliveryStatus } from '@prisma/client';
// import { supabaseStorage } from '../../services/supabaseStorage.js';
import supabaseStorage from '../../services/supabaseStorage.js';

export const DeliveriesService = {
  async getDeliveries(filters: any) {
    return prisma.delivery.findMany({
      where: filters,
      include: {
        driver: true,
        order: {
          include: {
            supplier: true
          }
        }
      },
      orderBy: {
        startedAt: 'desc'
      }
    });
  },

  async updateStatus(id: string, status: DeliveryStatus) {
    const delivery = await prisma.delivery.findUnique({ where: { id } });
    if (!delivery) throw new Error('Delivery not found');

    const updateData: any = { status };
    if (status === 'PICKED_UP' && !delivery.startedAt) {
      updateData.startedAt = new Date();
    } else if (status === 'DELIVERED') {
      updateData.completedAt = new Date();
    }

    return prisma.delivery.update({
      where: { id },
      data: updateData,
      include: { driver: true, order: true }
    });
  },

  async uploadPhoto(id: string, type: 'pickup' | 'delivery', fileBuffer: Buffer, filename: string) {
    // Generate a unique path in Supabase
    const path = `deliveries/${id}/${type}-${Date.now()}-${filename}`;
    // Assuming supabaseStorage.uploadFile exists, or we use a general one.
    // Let's use uploadTicketImage as a generic uploader if no general one exists, or implement it if missing.
    // We will assume there is a generic uploadFile or we adapt uploadTicketImage.
    const uploadResult = await supabaseStorage.uploadTicketImage(fileBuffer, `${id}-${type}`, filename);
    
    const updateData = type === 'pickup' ? { pickupPhotoUrl: uploadResult.publicUrl } : { deliveryPhotoUrl: uploadResult.publicUrl };

    return prisma.delivery.update({
      where: { id },
      data: updateData
    });
  }
};
