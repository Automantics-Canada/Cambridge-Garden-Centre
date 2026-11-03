/**
 * Saving agreed rates one at a time: add, edit, expire and delete.
 *
 * Before this, adding a rate looked the product up by name and overwrote
 * whatever it found, unit and start date included. Loading a new price list
 * would have wiped the old prices, so every invoice dated before the new start
 * lost its rate, and a product priced both per tonne and per skid could not be
 * stored at all. Editing passed the request body straight to the database, so
 * a cleared end date became an invalid date, and editing or deleting never
 * checked that the rate belonged to the supplier in the URL.
 *
 * The rules now live in rateRules.ts and are shared with the price-list
 * import. Every change is written in a transaction that holds a per-supplier
 * lock, so two people saving rates for the same supplier cannot interleave and
 * leave overlapping periods, and every change leaves an audit row.
 */
import { randomUUID } from 'node:crypto';
import { AuditActionType, AuditEntityType, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { businessDayOf } from '../../lib/businessDay.js';
import { normaliseUnit } from '../../lib/units.js';
import {
  findOverlap,
  isoOf,
  dateOf,
  parseIsoDate,
  parseRate,
  planRateChange,
  rateKey,
  resolveRateUnit,
  type PeriodRate,
  type RatePlan,
} from './rateRules.js';

type Tx = Prisma.TransactionClient;

export function rateFailure(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export const RATE_SELECT = {
  id: true,
  supplierId: true,
  productName: true,
  rate: true,
  unit: true,
  effectiveFrom: true,
  effectiveTo: true,
  notes: true,
  spruceItemCode: true,
  supplierItemCode: true,
} as const;

type StoredRate = Prisma.NegotiatedRateGetPayload<{ select: typeof RATE_SELECT }>;

export function toPeriodRate(row: StoredRate): PeriodRate {
  return {
    id: row.id,
    productName: row.productName,
    unit: row.unit,
    rate: Number(row.rate),
    effectiveFrom: isoOf(row.effectiveFrom)!,
    effectiveTo: isoOf(row.effectiveTo),
    notes: row.notes,
    spruceItemCode: row.spruceItemCode,
    supplierItemCode: row.supplierItemCode,
  };
}

/** What an audit row records about a rate: plain values, no Decimal objects. */
export function auditSnapshot(rate: PeriodRate) {
  return {
    productName: rate.productName,
    unit: rate.unit,
    rate: rate.rate,
    effectiveFrom: rate.effectiveFrom,
    effectiveTo: rate.effectiveTo,
    notes: rate.notes,
    spruceItemCode: rate.spruceItemCode,
    supplierItemCode: rate.supplierItemCode,
  };
}

/**
 * Serialises rate changes for one supplier until the transaction ends.
 *
 * The overlap rules are checked in code, not by a database constraint, so two
 * saves for the same supplier must not run their check-then-write at the same
 * time. `$executeRaw` because the lock function returns `void`, which a query
 * cannot deserialise.
 */
export async function lockSupplierRates(tx: Tx, supplierId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`negotiated-rate:${supplierId}`}))`;
}

export async function loadSupplierRates(tx: Tx, supplierId: string): Promise<PeriodRate[]> {
  const rows = await tx.negotiatedRate.findMany({
    where: { supplierId },
    select: RATE_SELECT,
    orderBy: { effectiveFrom: 'asc' },
  });
  return rows.map(toPeriodRate);
}

function sameKey(all: PeriodRate[], productName: string, unit: string): PeriodRate[] {
  const key = rateKey(productName, normaliseUnit(unit));
  return all.filter((rate) => rateKey(rate.productName, normaliseUnit(rate.unit)) === key);
}

// A malformed id in the URL is "not found", not a database error: Postgres
// refuses to cast it to uuid, which used to surface as a 500.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requireActiveSupplier(tx: Tx, supplierId: string): Promise<{ id: string; name: string }> {
  if (!UUID.test(supplierId)) throw rateFailure(404, 'Supplier not found');
  const supplier = await tx.supplier.findUnique({ where: { id: supplierId }, select: { id: true, name: true, active: true } });
  if (!supplier || !supplier.active) throw rateFailure(404, 'Supplier not found');
  return { id: supplier.id, name: supplier.name };
}

async function requireOwnedRate(tx: Tx, supplierId: string, rateId: string): Promise<PeriodRate> {
  if (!UUID.test(rateId)) throw rateFailure(404, 'Rate not found for this supplier');
  const row = await tx.negotiatedRate.findUnique({ where: { id: rateId }, select: RATE_SELECT });
  // The same answer for "no such rate" and "another supplier's rate", so the
  // URL cannot be used to probe or edit rates under the wrong supplier.
  if (!row || row.supplierId !== supplierId) throw rateFailure(404, 'Rate not found for this supplier');
  return toPeriodRate(row);
}

export async function auditRate(
  tx: Tx,
  actionType: AuditActionType,
  rateId: string,
  userId: string | null,
  details: Record<string, unknown>
): Promise<void> {
  await tx.auditLog.create({
    data: {
      entityType: AuditEntityType.RATE,
      entityId: rateId,
      actionType,
      performedById: userId,
      details: details as Prisma.InputJsonValue,
    },
  });
}

/** Text from a request body: undefined when absent, null when cleared. */
function bodyText(body: Record<string, unknown>, field: string, max: number): string | null | undefined {
  if (!(field in body) || body[field] === undefined) return undefined;
  const value = body[field];
  if (value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw rateFailure(400, `${field} must be text`);
  const text = String(value).trim();
  if (text.length > max) throw rateFailure(400, `${field} is longer than ${max} characters`);
  return text === '' ? null : text;
}

/** `YYYY-MM-DD`, also accepting the ISO timestamp an older page may send. */
function bodyDate(body: Record<string, unknown>, field: string): string | null | undefined {
  const text = bodyText(body, field, 40);
  if (text === undefined || text === null) return text;
  const iso = parseIsoDate(text.slice(0, 10));
  if (!iso) throw rateFailure(400, `${field} must be a date like 2026-11-01`);
  return iso;
}

function bodyRate(body: Record<string, unknown>): number | undefined {
  if (!('rate' in body) || body.rate === undefined) return undefined;
  const value = parseRate(body.rate as string | number);
  if (value === null) throw rateFailure(400, 'rate must be a price of 0 or more, like 18.50');
  return value;
}

function bodyUnit(body: Record<string, unknown>): string | undefined {
  const text = bodyText(body, 'unit', 40);
  if (text === undefined) return undefined;
  const unit = resolveRateUnit(text);
  if (!unit.ok) throw rateFailure(400, unit.message);
  return unit.label;
}

const PRODUCT_MAX = 200;
const CODE_MAX = 50;
const NOTES_MAX = 500;

export interface SavedRate {
  action: RatePlan['action'];
  rate: PeriodRate;
  supersededRateId?: string;
}

export const RateService = {
  /**
   * Adds a rate, closing the current period for the same product and unit when
   * the new one starts later. See planRateChange for the full rule.
   */
  async addRate(supplierId: string, body: Record<string, unknown>, userId: string): Promise<SavedRate> {
    const productName = bodyText(body, 'productName', PRODUCT_MAX)?.replace(/\s+/g, ' ');
    const rate = bodyRate(body);
    const unit = bodyUnit(body);
    const effectiveFrom = bodyDate(body, 'effectiveFrom');
    const effectiveTo = bodyDate(body, 'effectiveTo') ?? null;
    if (!productName || rate === undefined || !unit || !effectiveFrom) {
      throw rateFailure(400, 'productName, rate, unit and effectiveFrom are required');
    }
    const notes = bodyText(body, 'notes', NOTES_MAX);
    const spruceItemCode = bodyText(body, 'spruceItemCode', CODE_MAX);
    const supplierItemCode = bodyText(body, 'supplierItemCode', CODE_MAX);

    return prisma.$transaction(async (tx) => {
      await requireActiveSupplier(tx, supplierId);
      await lockSupplierRates(tx, supplierId);
      const all = await loadSupplierRates(tx, supplierId);

      const candidate = { productName, unit, rate, effectiveFrom, effectiveTo, notes, spruceItemCode, supplierItemCode };
      const plan = planRateChange(candidate, sameKey(all, productName, unit));

      switch (plan.action) {
        case 'ERROR':
          throw rateFailure(409, plan.message);
        case 'UNCHANGED':
          return { action: plan.action, rate: plan.rate };
        case 'CORRECT': {
          // Notes and codes are written only where the plan changes them: a
          // same-price rate re-added with a newer date and a blank box
          // corrects the running rate without clearing what it holds.
          const changing = (field: 'notes' | 'spruceItemCode' | 'supplierItemCode') =>
            plan.changes.some((change) => change.field === field);
          const updated = await tx.negotiatedRate.update({
            where: { id: plan.corrects.id },
            data: {
              productName,
              unit,
              rate,
              effectiveTo: effectiveTo ? dateOf(effectiveTo) : null,
              ...(changing('notes') ? { notes: notes ?? null } : {}),
              ...(changing('spruceItemCode') ? { spruceItemCode: spruceItemCode ?? null } : {}),
              ...(changing('supplierItemCode') ? { supplierItemCode: supplierItemCode ?? null } : {}),
            },
            select: RATE_SELECT,
          });
          const after = toPeriodRate(updated);
          await auditRate(tx, AuditActionType.RATE_UPDATED, updated.id, userId, {
            source: 'form',
            changes: plan.changes,
            before: auditSnapshot(plan.corrects),
            after: auditSnapshot(after),
          });
          return { action: plan.action, rate: after };
        }
        case 'SUPERSEDE':
        case 'CREATE': {
          const id = randomUUID();
          if (plan.action === 'SUPERSEDE') {
            await tx.negotiatedRate.update({
              where: { id: plan.supersedes.id },
              data: { effectiveTo: dateOf(plan.closeOn) },
            });
            await auditRate(tx, AuditActionType.RATE_EXPIRED, plan.supersedes.id, userId, {
              source: 'form',
              reason: 'superseded',
              supersededBy: id,
              before: auditSnapshot(plan.supersedes),
              effectiveTo: plan.closeOn,
            });
          }
          const created = await tx.negotiatedRate.create({
            data: {
              id,
              supplierId,
              productName,
              unit,
              rate,
              effectiveFrom: dateOf(effectiveFrom),
              effectiveTo: effectiveTo ? dateOf(effectiveTo) : null,
              notes: notes ?? null,
              spruceItemCode: spruceItemCode ?? null,
              supplierItemCode: supplierItemCode ?? null,
              createdById: userId,
            },
            select: RATE_SELECT,
          });
          const after = toPeriodRate(created);
          await auditRate(tx, AuditActionType.RATE_CREATED, id, userId, {
            source: 'form',
            ...(plan.action === 'SUPERSEDE' ? { supersedes: plan.supersedes.id } : {}),
            after: auditSnapshot(after),
          });
          return {
            action: plan.action,
            rate: after,
            ...(plan.action === 'SUPERSEDE' ? { supersededRateId: plan.supersedes.id } : {}),
          };
        }
      }
    });
  },

  /**
   * Edits one rate in place. Only the fields a person can see on the form are
   * accepted; anything else in the body is ignored, so a page cannot move a
   * rate to another supplier or rewrite who created it.
   */
  async updateRate(supplierId: string, rateId: string, body: Record<string, unknown>, userId: string): Promise<PeriodRate> {
    const productRaw = bodyText(body, 'productName', PRODUCT_MAX);
    if (productRaw === null) throw rateFailure(400, 'productName cannot be blank');
    const productName = productRaw?.replace(/\s+/g, ' ');
    const rate = bodyRate(body);
    // A blank unit is refused by resolveRateUnit as "Unit is missing".
    const unit = bodyUnit(body);
    const effectiveFrom = bodyDate(body, 'effectiveFrom');
    if (effectiveFrom === null) throw rateFailure(400, 'effectiveFrom cannot be blank');
    const effectiveTo = bodyDate(body, 'effectiveTo');
    const notes = bodyText(body, 'notes', NOTES_MAX);
    const spruceItemCode = bodyText(body, 'spruceItemCode', CODE_MAX);
    const supplierItemCode = bodyText(body, 'supplierItemCode', CODE_MAX);

    return prisma.$transaction(async (tx) => {
      await lockSupplierRates(tx, supplierId);
      const before = await requireOwnedRate(tx, supplierId, rateId);

      const after: PeriodRate = {
        ...before,
        ...(productName !== undefined ? { productName } : {}),
        ...(rate !== undefined ? { rate } : {}),
        ...(unit !== undefined ? { unit } : {}),
        ...(effectiveFrom !== undefined ? { effectiveFrom } : {}),
        ...(effectiveTo !== undefined ? { effectiveTo } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(spruceItemCode !== undefined ? { spruceItemCode } : {}),
        ...(supplierItemCode !== undefined ? { supplierItemCode } : {}),
      };

      if (after.effectiveTo !== null && after.effectiveTo < after.effectiveFrom) {
        throw rateFailure(400, 'effectiveTo is before effectiveFrom');
      }

      const changed = (Object.keys(auditSnapshot(after)) as Array<keyof ReturnType<typeof auditSnapshot>>).filter(
        (field) => auditSnapshot(after)[field] !== auditSnapshot(before)[field]
      );
      if (changed.length === 0) return before;

      const all = await loadSupplierRates(tx, supplierId);
      const clash = findOverlap(after, sameKey(all, after.productName, after.unit));
      if (clash) {
        throw rateFailure(
          409,
          `This period overlaps the rate from ${clash.effectiveFrom} to ${clash.effectiveTo ?? 'no end date'} ` +
            'for the same product and unit. Change that rate first.'
        );
      }

      const updated = await tx.negotiatedRate.update({
        where: { id: rateId },
        data: {
          productName: after.productName,
          rate: after.rate,
          unit: after.unit,
          effectiveFrom: dateOf(after.effectiveFrom),
          effectiveTo: after.effectiveTo ? dateOf(after.effectiveTo) : null,
          notes: after.notes,
          spruceItemCode: after.spruceItemCode,
          supplierItemCode: after.supplierItemCode,
        },
        select: RATE_SELECT,
      });
      const saved = toPeriodRate(updated);
      await auditRate(tx, AuditActionType.RATE_UPDATED, rateId, userId, {
        source: 'form',
        changed,
        before: auditSnapshot(before),
        after: auditSnapshot(saved),
      });
      return saved;
    });
  },

  /**
   * Ends a rate's period, by default today. The rate stays on record, so an
   * invoice dated while it applied is still checked against it.
   */
  async expireRate(supplierId: string, rateId: string, body: Record<string, unknown>, userId: string): Promise<PeriodRate> {
    const requested = bodyDate(body, 'effectiveTo');
    const effectiveTo = requested ?? businessDayOf();

    return prisma.$transaction(async (tx) => {
      await lockSupplierRates(tx, supplierId);
      const before = await requireOwnedRate(tx, supplierId, rateId);

      if (before.effectiveTo !== null && before.effectiveTo <= effectiveTo) {
        throw rateFailure(409, `This rate already ended on ${before.effectiveTo}.`);
      }
      if (effectiveTo < before.effectiveFrom) {
        throw rateFailure(
          409,
          `This rate only starts on ${before.effectiveFrom}. Pick an end date on or after that, or delete it if it was a mistake.`
        );
      }

      const updated = await tx.negotiatedRate.update({
        where: { id: rateId },
        data: { effectiveTo: dateOf(effectiveTo) },
        select: RATE_SELECT,
      });
      const saved = toPeriodRate(updated);
      await auditRate(tx, AuditActionType.RATE_EXPIRED, rateId, userId, {
        source: 'form',
        reason: 'expired',
        before: auditSnapshot(before),
        effectiveTo,
      });
      return saved;
    });
  },

  /**
   * Deletes a rate that never priced anything.
   *
   * A rate that already priced an invoice line is refused: deleting it would
   * leave that line pointing at a price nobody can see any more, and the next
   * re-check would mark the line "no agreed rate". Expire it instead.
   */
  async removeRate(supplierId: string, rateId: string, userId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await lockSupplierRates(tx, supplierId);
      const before = await requireOwnedRate(tx, supplierId, rateId);
      const used = await ratesInUse(tx, [rateId]);
      if (used.has(rateId)) {
        throw rateFailure(409, 'This rate has already priced invoice lines. Expire it instead, so older invoices keep their price.');
      }
      await tx.negotiatedRate.delete({ where: { id: rateId } });
      await auditRate(tx, AuditActionType.RATE_UPDATED, rateId, userId, {
        source: 'form',
        deleted: true,
        before: auditSnapshot(before),
      });
    });
  },
};

/**
 * Which of these rates have priced an invoice line.
 *
 * Lines do not point at the rate row; they carry the price that applied. So a
 * rate counts as used when a line on one of the supplier's invoices, dated
 * inside the rate's period, was priced at exactly this rate. That can count a
 * rate as used when another product shares its price in the same period,
 * which errs toward Expire, never toward losing a price.
 */
export async function ratesInUse(db: Pick<Tx, '$queryRaw'>, rateIds?: string[]): Promise<Set<string>> {
  if (rateIds && rateIds.length === 0) return new Set();
  const filter = rateIds ? Prisma.sql`AND r."id" IN (${Prisma.join(rateIds.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty;
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT r."id"::text AS id
    FROM "NegotiatedRate" r
    WHERE EXISTS (
      SELECT 1
      FROM "InvoiceLineItem" l
      JOIN "Invoice" i ON i."id" = l."invoiceId"
      WHERE i."supplierId" = r."supplierId"
        AND l."negotiatedRate" = r."rate"
        AND i."invoiceDate" >= r."effectiveFrom"
        AND (r."effectiveTo" IS NULL OR i."invoiceDate" <= r."effectiveTo")
    )
    ${filter}
  `;
  return new Set(rows.map((row) => row.id));
}
