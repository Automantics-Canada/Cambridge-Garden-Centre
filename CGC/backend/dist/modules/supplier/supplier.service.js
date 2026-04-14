import { prisma } from '../../db/prisma.js';
import { SupplierType } from '@prisma/client';
export const SupplierService = {
    async list() {
        return prisma.supplier.findMany({
            where: { active: true },
            orderBy: { name: 'asc' },
            include: {
                negotiatedRates: true
            }
        });
    },
    async create(data) {
        return prisma.supplier.create({ data });
    },
    async update(id, data) {
        return prisma.supplier.update({
            where: { id },
            data,
        });
    },
    async remove(id) {
        return prisma.supplier.update({
            where: { id },
            data: { active: false },
        });
    },
    async addNegotiatedRate(supplierId, data) {
        return prisma.negotiatedRate.create({
            data: {
                ...data,
                supplierId,
            }
        });
    },
    async removeNegotiatedRate(rateId) {
        return prisma.negotiatedRate.delete({
            where: { id: rateId }
        });
    },
    async updateNegotiatedRate(rateId, data) {
        return prisma.negotiatedRate.update({
            where: { id: rateId },
            data: {
                ...data,
                effectiveFrom: data.effectiveFrom ? new Date(data.effectiveFrom) : undefined,
                effectiveTo: data.effectiveTo ? new Date(data.effectiveTo) : undefined,
            }
        });
    }
};
//# sourceMappingURL=supplier.service.js.map