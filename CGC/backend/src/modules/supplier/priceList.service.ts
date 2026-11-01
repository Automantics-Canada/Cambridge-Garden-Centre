/**
 * Previewing and saving a supplier's price list.
 *
 * Preview reads the file and plans every row against the supplier's stored
 * rates, writing nothing. Save reads the same file again, plans it again under
 * the supplier's rate lock, and writes it only if the plan is exactly the one
 * the person was shown and no row is in error. Either every row is saved or
 * none is.
 */
import { randomUUID } from 'node:crypto';
import { AuditActionType, AuditEntityType, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { firstSheetWithRows, readSpreadsheet, type SpreadsheetKind } from '../../lib/spreadsheet.js';
import { dateOf, type TonMeaning } from './rateRules.js';
import { fileHashOf, planPriceList, planToken, type PriceListPlan } from './priceListImport.js';
import {
  auditSnapshot,
  loadSupplierRates,
  lockSupplierRates,
  rateFailure,
  requireActiveSupplier,
} from './rates.service.js';

/** The same bounds the upload enforces, restated for the reader. */
export const PRICE_LIST_MAX_BYTES = 2 * 1024 * 1024;
export const PRICE_LIST_MAX_ROWS = 5_000;

export interface PriceListFile {
  buffer: Buffer;
  originalname?: string;
}

export interface PriceListPreview {
  supplier: { id: string; name: string };
  file: { name: string | null; kind: SpreadsheetKind; sheet: string; otherSheets: string[]; truncated: boolean };
  tonMeans: TonMeaning | null;
  plan: PriceListPlan;
  /** Handed back on save; see planToken. */
  token: string;
}

export function parseTonMeans(raw: unknown): TonMeaning | null {
  if (raw === 'TONNE' || raw === 'SHORT_TON') return raw;
  if (raw === undefined || raw === null || raw === '') return null;
  throw rateFailure(400, 'tonMeans must be TONNE or SHORT_TON');
}

async function readPriceList(file: PriceListFile) {
  const sheetResult = await readSpreadsheet(file.buffer, {
    filename: file.originalname,
    limits: { maxBytes: PRICE_LIST_MAX_BYTES, maxRows: PRICE_LIST_MAX_ROWS + 1 },
  });
  const sheet = firstSheetWithRows(sheetResult);
  if (!sheet) throw rateFailure(400, 'The file has no rows.');
  if (sheet.truncated) {
    // A cut cell could be a cut price. All or nothing means refusing here.
    throw rateFailure(400, 'Some cells or columns are too long to read. Use the template columns only.');
  }
  return {
    kind: sheetResult.kind,
    sheet,
    otherSheets: sheetResult.sheets.filter((s) => s !== sheet && s.rows.length > 0).map((s) => s.name),
  };
}

async function buildPreview(
  db: Prisma.TransactionClient,
  supplierId: string,
  file: PriceListFile,
  tonMeans: TonMeaning | null
): Promise<PriceListPreview> {
  const supplier = await requireActiveSupplier(db, supplierId);
  const read = await readPriceList(file);
  const stored = await loadSupplierRates(db, supplierId);
  const plan = planPriceList(read.sheet.rows, read.sheet.rowNumbers, stored, { tonMeans });
  return {
    supplier,
    file: {
      name: file.originalname ?? null,
      kind: read.kind,
      sheet: read.sheet.name,
      otherSheets: read.otherSheets,
      truncated: read.sheet.truncated,
    },
    tonMeans,
    plan,
    token: planToken(supplierId, fileHashOf(file.buffer), tonMeans, plan),
  };
}

export const PriceListService = {
  /** Plans the file and writes nothing. */
  async preview(supplierId: string, file: PriceListFile, tonMeans: TonMeaning | null): Promise<PriceListPreview> {
    return buildPreview(prisma as unknown as Prisma.TransactionClient, supplierId, file, tonMeans);
  },

  /**
   * Saves the plan the preview showed, all or nothing.
   *
   * Refused with 409 and the fresh preview when the plan changed since (the
   * page then shows what would really happen), and with 422 when any row is in
   * error. Rows are written in one transaction with one audit row each.
   */
  async commit(
    supplierId: string,
    file: PriceListFile,
    options: { token: string; tonMeans: TonMeaning | null },
    userId: string
  ): Promise<{ counts: PriceListPlan['counts']; supplier: { id: string; name: string } }> {
    return prisma.$transaction(
      async (tx) => {
        await lockSupplierRates(tx, supplierId);
        const preview = await buildPreview(tx, supplierId, file, options.tonMeans);

        if (!options.token || preview.token !== options.token) {
          throw Object.assign(
            rateFailure(409, 'The rates or the file changed since the preview. Check the new preview, then save again.'),
            { preview }
          );
        }
        if (!preview.plan.canCommit) {
          throw Object.assign(
            rateFailure(422, 'Nothing was saved. Fix the rows marked as errors, then check the file again.'),
            { preview }
          );
        }

        const source = { source: 'price-list', fileName: preview.file.name, fileHash: fileHashOf(file.buffer) };
        const creates: Prisma.NegotiatedRateCreateManyInput[] = [];
        const audits: Prisma.AuditLogCreateManyInput[] = [];
        const audit = (actionType: AuditActionType, entityId: string, details: Record<string, unknown>) =>
          audits.push({
            entityType: AuditEntityType.RATE,
            entityId,
            actionType,
            performedById: userId,
            details: { ...source, ...details } as Prisma.InputJsonValue,
          });

        for (const row of preview.plan.rows) {
          const value = row.value;
          if (!value) continue;

          if (row.action === 'SUPERSEDE' && row.supersedes) {
            await tx.negotiatedRate.update({
              where: { id: row.supersedes.rateId },
              data: { effectiveTo: dateOf(row.supersedes.closeOn) },
            });
          }

          if (row.action === 'CORRECT' && row.corrects) {
            await tx.negotiatedRate.update({
              where: { id: row.corrects.rateId },
              data: {
                productName: value.productName,
                unit: value.unit,
                rate: value.rate,
                effectiveTo: value.effectiveTo ? dateOf(value.effectiveTo) : null,
                ...(value.notes !== undefined ? { notes: value.notes } : {}),
                ...(value.spruceItemCode !== undefined ? { spruceItemCode: value.spruceItemCode } : {}),
                ...(value.supplierItemCode !== undefined ? { supplierItemCode: value.supplierItemCode } : {}),
              },
            });
            audit(AuditActionType.RATE_UPDATED, row.corrects.rateId, { rowNumber: row.rowNumber, changes: row.corrects.changes });
          }

          if (row.action === 'CREATE' || row.action === 'SUPERSEDE') {
            const id = randomUUID();
            creates.push({
              id,
              supplierId,
              productName: value.productName,
              unit: value.unit,
              rate: value.rate,
              effectiveFrom: dateOf(value.effectiveFrom),
              effectiveTo: value.effectiveTo ? dateOf(value.effectiveTo) : null,
              notes: value.notes ?? null,
              spruceItemCode: value.spruceItemCode ?? null,
              supplierItemCode: value.supplierItemCode ?? null,
              createdById: userId,
            });
            if (row.supersedes) {
              audit(AuditActionType.RATE_EXPIRED, row.supersedes.rateId, {
                rowNumber: row.rowNumber,
                reason: 'superseded',
                supersededBy: id,
                before: { rate: row.supersedes.rate, effectiveFrom: row.supersedes.effectiveFrom, effectiveTo: row.supersedes.effectiveTo },
                effectiveTo: row.supersedes.closeOn,
              });
            }
            audit(AuditActionType.RATE_CREATED, id, {
              rowNumber: row.rowNumber,
              ...(row.supersedes ? { supersedes: row.supersedes.rateId } : {}),
              after: auditSnapshot({
                id,
                productName: value.productName,
                unit: value.unit,
                rate: value.rate,
                effectiveFrom: value.effectiveFrom,
                effectiveTo: value.effectiveTo,
                notes: value.notes ?? null,
                spruceItemCode: value.spruceItemCode ?? null,
                supplierItemCode: value.supplierItemCode ?? null,
              }),
            });
          }
        }

        if (creates.length > 0) await tx.negotiatedRate.createMany({ data: creates });
        if (audits.length > 0) await tx.auditLog.createMany({ data: audits });

        return { counts: preview.plan.counts, supplier: preview.supplier };
      },
      // Up to 5,000 rows in one transaction: more time than the default five
      // seconds, still bounded.
      { maxWait: 10_000, timeout: 60_000 }
    );
  },
};
