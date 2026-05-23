import { prisma } from "../../db/prisma.js";
export const ProductService = {
    async list() {
        return prisma.product.findMany({
            orderBy: { name: "asc" },
        });
    },
    async create(data) {
        return prisma.product.create({
            data,
        });
    },
    async update(id, data) {
        return prisma.product.update({
            where: { id },
            data,
        });
    },
    async remove(id) {
        return prisma.product.delete({
            where: { id },
        });
    },
};
//# sourceMappingURL=product.service.js.map