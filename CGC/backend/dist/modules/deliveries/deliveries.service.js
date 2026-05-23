import { prisma } from '../../db/prisma.js';
import { DeliveryStatus } from '@prisma/client';
import supabaseStorage from '../../services/supabaseStorage.js';
export const DeliveriesService = {
    async getDeliveries(filters) {
        return prisma.delivery.findMany({
            where: filters,
            include: {
                driver: true,
                order: {
                    include: {
                        supplier: true
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
    async updateStatus(id, status, notes) {
        const delivery = await prisma.delivery.findUnique({ where: { id } });
        if (!delivery)
            throw new Error('Delivery not found');
        const updateData = { status };
        if (status === 'IN_TRANSIT' && !delivery.startedAt) {
            updateData.startedAt = new Date();
        }
        else if (status === 'DELIVERED') {
            updateData.completedAt = new Date();
        }
        const updated = await prisma.delivery.update({
            where: { id },
            data: updateData,
            include: { driver: true, order: true }
        });
        // Record history
        await prisma.deliveryHistory.create({
            data: {
                deliveryId: id,
                status,
                notes: notes || `Status updated to ${status}`
            }
        });
        return updated;
    },
    async uploadPhoto(id, type, fileBuffer, filename) {
        const uploadResult = await supabaseStorage.uploadTicketImage(fileBuffer, `${id}-${type}`, filename);
        const updateData = type === 'pickup' ? { pickupPhotoUrl: uploadResult.publicUrl } : { deliveryPhotoUrl: uploadResult.publicUrl };
        return prisma.delivery.update({
            where: { id },
            data: updateData
        });
    }
};
//# sourceMappingURL=deliveries.service.js.map