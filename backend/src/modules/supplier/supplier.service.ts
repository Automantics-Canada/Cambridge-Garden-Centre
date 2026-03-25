import { prisma } from '../../db/prisma';
import { SupplierType } from '@prisma/client';

export const SupplierService = {
  async list() {
    return prisma.supplier.findMany({
      orderBy: { name: 'asc' },
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
};
