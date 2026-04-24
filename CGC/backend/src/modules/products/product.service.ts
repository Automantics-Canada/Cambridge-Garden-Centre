import { prisma } from "../../db/prisma.js";

export const ProductService = {
  async list() {
    return prisma.product.findMany({
      orderBy: { name: "asc" },
    });
  },

  async create(data: { name: string; unit?: string }) {
    return prisma.product.create({
      data,
    });
  },

  async update(id: string, data: { name: string; unit?: string }) {
    return prisma.product.update({
      where: { id },
      data,
    });
  },

  async remove(id: string) {
    return prisma.product.delete({
      where: { id },
    });
  },
};
