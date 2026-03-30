import { prisma } from '../../db/prisma.js';
import { SupplierType } from '@prisma/client';
export const SupplierService = {
    async list() {
        return prisma.supplier.findMany({
            orderBy: { name: 'asc' },
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
};
//# sourceMappingURL=supplier.service.js.map