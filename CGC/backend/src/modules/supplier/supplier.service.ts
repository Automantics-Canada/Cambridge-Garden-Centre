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

  async create(data: {
    name: string;
    type: SupplierType;
    emailDomains: string[];
    contactName?: string;
    contactEmail?: string;
    phone?: string;
    address?: string;
  }) {
    return prisma.supplier.create({ data });
  },

  async update(id: string, data: Partial<{
    name: string;
    type: SupplierType;
    emailDomains: string[];
    contactName?: string;
    contactEmail?: string;
    phone?: string;
    address?: string;
    active?: boolean;
  }>) {
    return prisma.supplier.update({
      where: { id },
      data,
    });
  },

  async remove(id: string) {
    return prisma.supplier.update({
      where: { id },
      data: { active: false },
    });
  },

  async addNegotiatedRate(supplierId: string, data: {
    productName: string;
    rate: number;
    unit: string;
    effectiveFrom: Date;
    effectiveTo?: Date;
    notes?: string;
    createdById: string;
  }) {
    return prisma.negotiatedRate.create({
      data: {
        ...data,
        supplierId,
      }
    });
  },

  async removeNegotiatedRate(rateId: string) {
    return prisma.negotiatedRate.delete({
      where: { id: rateId }
    });
  }
};