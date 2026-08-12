import { prisma } from '../../db/prisma.js';
import { SupplierType } from '@prisma/client';
import { compareTwoStrings } from 'string-similarity';
import path from 'node:path';
import fs from 'node:fs';

export const SupplierService = {
  async findOrCreateSupplier(name: string | null): Promise<{ id: string; name: string } | null> {
    if (!name) return null;
    const trimmedName = name.trim();
    if (!trimmedName) return null;

    const logPath = path.join(process.cwd(), 'ocr_debug.log');
    fs.appendFileSync(logPath, `\n[${new Date().toISOString()}] Attempting match for: "${trimmedName}"\n`);

    const supplier = await prisma.supplier.findFirst({
      where: {
        name: { equals: trimmedName, mode: 'insensitive' },
      },
    });
    if (supplier) {
      fs.appendFileSync(logPath, `Exact match found: ${supplier.name}\n`);
      return supplier;
    }

    // Try contains
    const containsSupplier = await prisma.supplier.findFirst({
      where: {
        name: { contains: trimmedName, mode: 'insensitive' },
      },
    });
    if (containsSupplier) {
      fs.appendFileSync(logPath, `Contains match found: ${containsSupplier.name}\n`);
      return containsSupplier;
    }

    // Fuzzy match against all active suppliers
    fs.appendFileSync(logPath, `No direct match. Candidates:\n`);
    const allSuppliers = await prisma.supplier.findMany({ where: { active: true } });
    let bestMatch = null;
    let highestSimilarity = 0;

    for (const s of allSuppliers) {
      const similarity = compareTwoStrings(trimmedName.toLowerCase(), s.name.toLowerCase());
      fs.appendFileSync(logPath, ` - Candidate: "${s.name}" | Score: ${similarity.toFixed(4)}\n`);
      if (similarity > highestSimilarity) {
        highestSimilarity = similarity;
        bestMatch = s;
      }
    }

    if (bestMatch && highestSimilarity > 0.75) {
      fs.appendFileSync(logPath, `WINNER: "${bestMatch.name}" (Score: ${highestSimilarity.toFixed(4)})\n`);
      return bestMatch;
    }

    // If no match found, create a new supplier!
    fs.appendFileSync(logPath, `Creating new supplier: "${trimmedName}"\n`);
    const newSupplier = await prisma.supplier.create({
      data: {
        name: trimmedName,
        type: SupplierType.SUPPLIER,
        emailDomains: [],
        keywords: [],
      },
    });
    return newSupplier;
  },

  /**
   * Minimal projection for filter dropdowns.
   *
   * The full list() includes negotiated rates and every supplier column. The
   * tickets screen was pulling all of that just to render <option> elements,
   * which measured ~2.7s in production.
   */
  async listOptions() {
    return prisma.supplier.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  },

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
    keywords: string[];
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
    keywords: string[];
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
    const trimmedProduct = data.productName.trim();
    const existingRate = await prisma.negotiatedRate.findFirst({
      where: {
        supplierId,
        productName: {
          equals: trimmedProduct,
          mode: 'insensitive'
        }
      }
    });

    if (existingRate) {
      return prisma.negotiatedRate.update({
        where: { id: existingRate.id },
        data: {
          productName: trimmedProduct,
          rate: data.rate,
          unit: data.unit,
          effectiveFrom: data.effectiveFrom,
          ...(data.effectiveTo !== undefined ? { effectiveTo: data.effectiveTo } : {}),
          ...(data.notes !== undefined ? { notes: data.notes } : {}),
        }
      });
    }

    return prisma.negotiatedRate.create({
      data: {
        ...data,
        productName: trimmedProduct,
        supplierId,
      }
    });
  },

  async removeNegotiatedRate(rateId: string) {
    return prisma.negotiatedRate.delete({
      where: { id: rateId }
    });
  },

  async updateNegotiatedRate(rateId: string, data: Partial<{
    productName: string;
    rate: number;
    unit: string;
    effectiveFrom: Date;
    effectiveTo?: Date;
    notes?: string;
  }>) {
    return prisma.negotiatedRate.update({
      where: { id: rateId },
      data: {
        ...data,
        ...(data.effectiveFrom !== undefined && { effectiveFrom: new Date(data.effectiveFrom) }),
        ...(data.effectiveTo !== undefined && { effectiveTo: new Date(data.effectiveTo) }),
      }
    });
  }
};