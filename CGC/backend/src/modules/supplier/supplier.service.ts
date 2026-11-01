import { prisma } from '../../db/prisma.js';
import { SupplierType } from '@prisma/client';
import { compareTwoStrings } from 'string-similarity';
import { normalizeProductName } from '../../lib/productName.js';
import { ratesInUse } from './rates.service.js';

export const SupplierService = {
  async findOrCreateSupplier(name: string | null): Promise<{ id: string; name: string } | null> {
    if (!name) return null;
    const trimmedName = name.trim();
    if (!trimmedName) return null;

    const supplier = await prisma.supplier.findFirst({
      where: {
        name: { equals: trimmedName, mode: 'insensitive' },
      },
    });
    if (supplier) {
      console.log(`[Supplier] Exact match for "${trimmedName}": ${supplier.name}`);
      return supplier;
    }

    // Try contains
    const containsSupplier = await prisma.supplier.findFirst({
      where: {
        name: { contains: trimmedName, mode: 'insensitive' },
      },
    });
    if (containsSupplier) {
      console.log(`[Supplier] Contains match for "${trimmedName}": ${containsSupplier.name}`);
      return containsSupplier;
    }

    // Fuzzy match against all active suppliers
    const allSuppliers = await prisma.supplier.findMany({ where: { active: true } });
    let bestMatch = null;
    let highestSimilarity = 0;

    for (const s of allSuppliers) {
      const similarity = compareTwoStrings(trimmedName.toLowerCase(), s.name.toLowerCase());
      if (similarity > highestSimilarity) {
        highestSimilarity = similarity;
        bestMatch = s;
      }
    }

    if (bestMatch && highestSimilarity > 0.75) {
      console.log(`[Supplier] Fuzzy match for "${trimmedName}": ${bestMatch.name} (${highestSimilarity.toFixed(3)})`);
      return bestMatch;
    }

    // If no match found, create a new supplier!
    console.log(`[Supplier] No match for "${trimmedName}" (best ${highestSimilarity.toFixed(3)}). Creating it.`);
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
   * Product aliases recorded for a supplier, newest first.
   */
  async listProductAliases(supplierId: string) {
    return prisma.supplierProductAlias.findMany({
      where: { supplierId },
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * Records "this supplier's wording means this product of ours".
   *
   * `productName` must name an existing negotiated rate for the same supplier,
   * otherwise the alias would point at nothing and the line would still fall
   * through to fuzzy matching without anyone being told why.
   *
   * The alias text is normalised on the way in so lookup is exact regardless of
   * the casing and punctuation the supplier happens to print.
   */
  async addProductAlias(supplierId: string, aliasText: string, productName: string, userId?: string) {
    const normalised = normalizeProductName(aliasText);
    if (!normalised) {
      throw Object.assign(new Error('aliasText is required'), { status: 400 });
    }

    const rate = await prisma.negotiatedRate.findFirst({
      where: { supplierId, productName: { equals: productName.trim(), mode: 'insensitive' } },
      select: { productName: true },
    });

    if (!rate) {
      throw Object.assign(
        new Error(`No negotiated rate named "${productName}" exists for this supplier`),
        { status: 400 }
      );
    }

    return prisma.supplierProductAlias.upsert({
      where: { supplierId_aliasText: { supplierId, aliasText: normalised } },
      update: { productName: rate.productName, createdById: userId ?? null },
      create: {
        supplierId,
        aliasText: normalised,
        productName: rate.productName,
        createdById: userId ?? null,
      },
    });
  },

  async removeProductAlias(supplierId: string, aliasId: string) {
    const alias = await prisma.supplierProductAlias.findUnique({ where: { id: aliasId } });
    if (!alias || alias.supplierId !== supplierId) {
      throw Object.assign(new Error('Alias not found for this supplier'), { status: 404 });
    }
    return prisma.supplierProductAlias.delete({ where: { id: aliasId } });
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

  /**
   * Active suppliers with their rates, newest period first.
   *
   * Each rate carries `inUse`: whether it has already priced an invoice line.
   * The pages offer Expire instead of Delete for those, because deleting one
   * would leave its invoices pointing at a price nobody can see.
   */
  async list() {
    const suppliers = await prisma.supplier.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      include: {
        negotiatedRates: { orderBy: [{ productName: 'asc' }, { effectiveFrom: 'desc' }] },
      },
    });
    const inUse = await ratesInUse(prisma);
    return suppliers.map((supplier) => ({
      ...supplier,
      negotiatedRates: supplier.negotiatedRates.map((rate) => ({ ...rate, inUse: inUse.has(rate.id) })),
    }));
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
};
