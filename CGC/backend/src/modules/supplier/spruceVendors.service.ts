/**
 * The Spruce vendor codes each supplier bills under, managed from the
 * Supplier page.
 *
 * Spruce names vendors by code (`EXAMPLEV01`), never by the supplier's name, so
 * an import resolves a line's supplier only through this mapping. Until now the
 * mapping could only be changed with `npm run vendors:add`, which the client
 * cannot run; every unmapped code meant order lines with no supplier, which
 * invoice matching and the driver's pickup both depend on. As the yard attaches
 * POs before the reports run (A5), more lines carry vendor codes, so the
 * mapping has to be something the office can keep up to date.
 *
 * Same rules as the script: codes are upper-case, one supplier per code, and
 * removing a code retires it rather than deleting it, so an old report
 * re-imported later cannot silently re-point at someone else.
 */
import { AuditActionType, AuditEntityType, type Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { recomputeForPoNumbersSafely } from '../matching/matching.service.js';

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;

function failure(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** The code as Spruce prints it, or null when it cannot be a vendor code. */
export function normaliseVendorCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

export interface UnmappedVendorCode {
  code: string;
  /** Order lines that carry this code and still have no supplier. */
  lineCount: number;
  lastSeen: string | null;
  /** The yard or pit Spruce printed beside the code, as a hint. */
  location: string | null;
}

export const SpruceVendorService = {
  async listForSupplier(supplierId: string) {
    const supplier = await prisma.supplier.findUnique({ where: { id: supplierId }, select: { id: true } });
    if (!supplier) throw failure(404, 'Supplier not found');
    return prisma.supplierSpruceVendor.findMany({
      where: { supplierId },
      select: { code: true, active: true, createdAt: true },
      orderBy: [{ active: 'desc' }, { code: 'asc' }],
    });
  },

  /**
   * Codes that imported order lines carry but no active mapping covers.
   *
   * This is what the import reported as "has no supplier mapping", read back
   * from the lines it left unlinked, so the office can map them without
   * hunting through import results.
   */
  async listUnmapped(limit = 100): Promise<UnmappedVendorCode[]> {
    const rows = await prisma.$queryRaw<Array<{ code: string; lineCount: bigint; lastSeen: Date | null; location: string | null }>>`
      SELECT upper(trim(o."vendorCode")) AS code,
             count(*) AS "lineCount",
             max(o."createdAt") AS "lastSeen",
             max(o."vendorLocation") AS location
      FROM "Order" o
      WHERE o."vendorCode" IS NOT NULL
        AND trim(o."vendorCode") <> ''
        AND o."supplierId" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "SupplierSpruceVendor" v
          WHERE v."code" = upper(trim(o."vendorCode")) AND v."active" = true
        )
      GROUP BY upper(trim(o."vendorCode"))
      ORDER BY max(o."createdAt") DESC NULLS LAST
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      code: row.code,
      lineCount: Number(row.lineCount),
      lastSeen: row.lastSeen ? row.lastSeen.toISOString() : null,
      location: row.location,
    }));
  },

  /**
   * Maps a code to this supplier, or re-activates a retired one.
   *
   * A code that is active under a different supplier is refused and names that
   * supplier: moving it is a decision about who gets paid, so the person
   * retires it there first. Order lines already imported with this code and no
   * supplier are linked now, as the next import would do, and their POs are
   * re-matched in the background.
   */
  async addCode(supplierId: string, rawCode: unknown, userId: string) {
    const code = normaliseVendorCode(rawCode);
    if (!code) {
      throw failure(400, 'Enter the vendor code exactly as Spruce prints it, e.g. EXAMPLEV01 (letters, digits, . _ -).');
    }

    const outcome = await prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.findUnique({ where: { id: supplierId }, select: { id: true, name: true, active: true } });
      if (!supplier) throw failure(404, 'Supplier not found');
      if (!supplier.active) throw failure(409, `${supplier.name} is inactive. Activate it first.`);

      const existing = await tx.supplierSpruceVendor.findUnique({
        where: { code },
        include: { supplier: { select: { name: true } } },
      });
      if (existing?.active && existing.supplierId !== supplierId) {
        throw failure(409, `${code} already belongs to ${existing.supplier.name}. Remove it there first.`);
      }
      if (existing?.active && existing.supplierId === supplierId) {
        return { mapping: existing, linkedLines: 0, poNumbers: [] as string[], changed: false };
      }

      const mapping = await tx.supplierSpruceVendor.upsert({
        where: { code },
        update: { supplierId, active: true },
        create: { code, supplierId },
      });

      const unlinked = await tx.order.findMany({
        where: { supplierId: null, vendorCode: { equals: code, mode: 'insensitive' } },
        select: { id: true, poNumber: true },
      });
      if (unlinked.length > 0) {
        await tx.order.updateMany({
          where: { id: { in: unlinked.map((line) => line.id) }, supplierId: null },
          data: { supplierId },
        });
      }

      await tx.auditLog.create({
        data: {
          entityType: AuditEntityType.SUPPLIER,
          entityId: supplierId,
          actionType: AuditActionType.SPRUCE_VENDOR_MAPPED,
          performedById: userId,
          details: {
            code,
            ...(existing ? { previousSupplierId: existing.supplierId, wasRetired: !existing.active } : {}),
            linkedLines: unlinked.length,
          } as Prisma.InputJsonValue,
        },
      });

      return {
        mapping,
        linkedLines: unlinked.length,
        poNumbers: unlinked.flatMap((line) => (line.poNumber ? [line.poNumber] : [])),
        changed: true,
      };
    });

    if (outcome.poNumbers.length > 0) {
      void recomputeForPoNumbersSafely(outcome.poNumbers, `Vendor code ${code} mapped`);
    }

    return {
      code: outcome.mapping.code,
      active: outcome.mapping.active,
      createdAt: outcome.mapping.createdAt,
      linkedLines: outcome.linkedLines,
      changed: outcome.changed,
    };
  },

  /**
   * Retires one of this supplier's codes. The lines already linked keep their
   * supplier; only later imports stop resolving the code.
   */
  async retireCode(supplierId: string, rawCode: unknown, userId: string) {
    const code = normaliseVendorCode(rawCode);
    if (!code) throw failure(404, 'Vendor code not found for this supplier');

    return prisma.$transaction(async (tx) => {
      const existing = await tx.supplierSpruceVendor.findUnique({ where: { code } });
      if (!existing || existing.supplierId !== supplierId) throw failure(404, 'Vendor code not found for this supplier');
      if (!existing.active) return { code, active: false, createdAt: existing.createdAt };

      const saved = await tx.supplierSpruceVendor.update({ where: { code }, data: { active: false } });
      await tx.auditLog.create({
        data: {
          entityType: AuditEntityType.SUPPLIER,
          entityId: supplierId,
          actionType: AuditActionType.SPRUCE_VENDOR_RETIRED,
          performedById: userId,
          details: { code } as Prisma.InputJsonValue,
        },
      });
      return { code: saved.code, active: saved.active, createdAt: saved.createdAt };
    });
  },
};
