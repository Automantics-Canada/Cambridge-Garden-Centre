import { prisma } from '../../db/prisma.js';
import { SupplierType } from '@prisma/client';
import { compareTwoStrings } from 'string-similarity';
import { normalizeProductName } from '../../lib/productName.js';

export interface SupplierRef {
  id: string;
  name: string;
}

/** How an OCR-read supplier name was resolved, if at all. */
export type OcrSupplierMatchMethod = 'EXACT_NAME' | 'EMAIL_DOMAIN' | 'SUGGESTED' | 'NONE';

export interface OcrSupplierResolution {
  /** Non-null only for an unambiguous exact match. Safe to attach. */
  supplier: SupplierRef | null;
  method: OcrSupplierMatchMethod;
  /** A close match for a person to confirm. Never attached automatically. */
  suggestion: (SupplierRef & { score: number }) | null;
  /** Why nothing was attached. Null when a supplier was resolved. */
  reason: string | null;
}

/**
 * How close a name has to be before it is worth showing as a suggestion.
 *
 * Only ever used to *propose*. The automatic-attachment threshold is exact
 * equality; there is no similarity score high enough to link a supplier without
 * a person.
 */
const OCR_SUGGESTION_THRESHOLD = 0.6;

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
   * Resolve a supplier from a name that OCR read off a document. Read-only.
   *
   * `findOrCreateSupplier` must never be reached from an automated OCR path.
   * It creates a supplier when nothing matches, and it accepts a 0.75 string
   * similarity as a match — so a misread letterhead either invented a duplicate
   * supplier record or attached a delivery to whichever existing supplier
   * happened to be spelled most like the misreading. Both are silent, and both
   * corrupt the supplier dimension that invoice matching and the negotiated
   * rate tables depend on.
   *
   * This resolver only ever *finds*:
   *
   *   - an exact name match (case-insensitive) is used;
   *   - an exact match on a recorded email domain is used;
   *   - a close-but-not-exact match is returned as a *suggestion* and is not
   *     attached to anything;
   *   - more than one equally good match resolves to nothing.
   *
   * Anything short of an unambiguous exact match leaves the document's supplier
   * where it was, with a reason for the review desk.
   */
  async resolveSupplierForOcr(
    name: string | null,
    options: { emailDomain?: string | null } = {}
  ): Promise<OcrSupplierResolution> {
    const trimmed = name?.trim() ?? '';

    if (!trimmed && !options.emailDomain) {
      return { supplier: null, method: 'NONE', suggestion: null, reason: 'No supplier name was read from the document' };
    }

    if (trimmed) {
      const exact = await prisma.supplier.findMany({
        where: { name: { equals: trimmed, mode: 'insensitive' } },
        select: { id: true, name: true },
        take: 2,
      });

      // Two suppliers sharing a name is a data problem a person has to settle;
      // picking one here would attach the document to a coin flip.
      if (exact.length === 1) {
        return { supplier: exact[0] as SupplierRef, method: 'EXACT_NAME', suggestion: null, reason: null };
      }
      if (exact.length > 1) {
        return {
          supplier: null,
          method: 'NONE',
          suggestion: null,
          reason: `More than one supplier is recorded under this name; pick the right one`,
        };
      }
    }

    const domain = options.emailDomain?.trim().toLowerCase();
    if (domain) {
      const byDomain = await prisma.supplier.findMany({
        where: { emailDomains: { has: domain } },
        select: { id: true, name: true },
        take: 2,
      });
      if (byDomain.length === 1) {
        return { supplier: byDomain[0] as SupplierRef, method: 'EMAIL_DOMAIN', suggestion: null, reason: null };
      }
      if (byDomain.length > 1) {
        return {
          supplier: null,
          method: 'NONE',
          suggestion: null,
          reason: 'More than one supplier is recorded against this email domain',
        };
      }
    }

    if (!trimmed) {
      return { supplier: null, method: 'NONE', suggestion: null, reason: 'No supplier name was read from the document' };
    }

    // Nothing exact. Offer the closest active supplier as something for a person
    // to confirm — a suggestion is written nowhere and links nothing.
    const active = await prisma.supplier.findMany({
      where: { active: true },
      select: { id: true, name: true },
    });

    let best: SupplierRef | null = null;
    let bestScore = 0;
    let tied = false;

    for (const candidate of active) {
      const score = compareTwoStrings(trimmed.toLowerCase(), candidate.name.toLowerCase());
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
        tied = false;
      } else if (score === bestScore && bestScore > 0) {
        tied = true;
      }
    }

    if (best && !tied && bestScore >= OCR_SUGGESTION_THRESHOLD) {
      return {
        supplier: null,
        method: 'SUGGESTED',
        suggestion: { ...best, score: Number(bestScore.toFixed(3)) },
        reason: `Supplier not matched exactly; "${best.name}" looks close — confirm it`,
      };
    }

    return {
      supplier: null,
      method: 'NONE',
      suggestion: null,
      reason: 'Supplier name on the document does not match any recorded supplier',
    };
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