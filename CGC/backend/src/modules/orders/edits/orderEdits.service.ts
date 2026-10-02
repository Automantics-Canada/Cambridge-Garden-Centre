import type { Prisma } from '@prisma/client';

import { prisma } from '../../../db/prisma.js';
import {
  combineFlags,
  isPickupOrder,
  normalizeAddress,
  stateFlags,
  type OrderFlag,
} from '../import/mergeOrderFacts.js';
import { NO_UPDATES, updatesForDay } from '../import/orderChanges.js';
import { awaitingSupplierByOrder } from '../../dispatch/dispatchOrderView.js';
import {
  EditValidationError,
  columnToStored,
  fieldKind,
  storedToColumn,
  targetKeyOf,
  type LineField,
  type OrderField,
  type ParsedEdits,
  type StoredValue,
} from './editableFields.js';

/**
 * Corrections a dispatcher makes to an order, and keeping them through imports.
 *
 * A correction is written into the order's own column, so every screen — and
 * the driver's phone, which reads the database through its own function —
 * shows it without knowing corrections exist. The OrderOverride row beside it
 * keeps what Spruce says. After every import, `reassertOverrides` records the
 * value Spruce just wrote and puts the correction back.
 */

type Db = Prisma.TransactionClient;

export class OrderEditError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const CHANGED: OrderFlag = 'SPRUCE_VALUE_CHANGED';

/** Fields of the order that its lines repeat, and must keep in step. */
const REPEATED_ON_LINES: OrderField[] = ['customerName', 'deliveryDate'];

/**
 * Everything that follows from an order's fields: the tidied address, whether
 * it is a pickup, and the flags read off its state. Run after any correction
 * or reset, and after an import of an order that has corrections, so a filled
 * address clears "No address" and a moved date moves the order.
 */
async function recomputeDerived(db: Db, documentId: string): Promise<void> {
  const document = await db.orderDocument.findUniqueOrThrow({
    where: { id: documentId },
    select: {
      customerName: true,
      deliveryDate: true,
      shippingAddress: true,
      deliveryInstructions: true,
      flags: true,
      lines: { select: { spruceItemNumber: true, product: true, poNumber: true } },
      overrides: { select: { field: true, spruceChanged: true } },
    },
  });

  const state = {
    deliveryDate: document.deliveryDate,
    shippingAddress: document.shippingAddress,
    deliveryInstructions: document.deliveryInstructions,
    lines: document.lines.map(line => ({ itemCode: line.spruceItemNumber, description: line.product, poNumber: line.poNumber })),
  };
  const isPickup = document.flags.includes('NOT_OPEN') ? false : isPickupOrder(state);
  const fresh = stateFlags(state, isPickup);
  if (document.overrides.some(override => override.spruceChanged)) fresh.push(CHANGED);

  await db.orderDocument.update({
    where: { id: documentId },
    data: {
      addressNormalized: normalizeAddress(document.shippingAddress),
      isPickup,
      flags: combineFlags(document.flags, [CHANGED], fresh),
    },
  });

  const corrected = new Set(document.overrides.map(override => override.field));
  if (REPEATED_ON_LINES.some(field => corrected.has(field))) {
    await db.order.updateMany({
      where: { documentId },
      data: { customerName: document.customerName, deliveryDate: document.deliveryDate },
    });
  }
}

/**
 * Puts an order's corrections back after an import, keeping what Spruce said.
 *
 * Wherever an import has written a different value into a corrected column,
 * that value is Spruce's latest: it is kept on the override, flagged if it
 * differs from what Spruce said when the correction was made, and the
 * correction is written back. A column still holding the correction means the
 * import did not touch it. Returns false, having changed nothing, for an order
 * without corrections.
 */
export async function reassertOverrides(db: Db, documentId: string): Promise<boolean> {
  const overrides = await db.orderOverride.findMany({ where: { documentId } });
  if (overrides.length === 0) return false;

  const document = await db.orderDocument.findUniqueOrThrow({ where: { id: documentId } });
  const lines = new Map(
    (await db.order.findMany({ where: { documentId } })).map(line => [line.id, line])
  );

  for (const override of overrides) {
    const lineLevel = override.lineId !== null;
    const kind = fieldKind(override.field, lineLevel);
    const row = lineLevel ? lines.get(override.lineId!) : document;
    if (!kind || !row) continue;

    const current = columnToStored((row as Record<string, unknown>)[override.field]);
    if (current === override.value) continue;

    await db.orderOverride.update({
      where: { id: override.id },
      data: { spruceValue: current, spruceChanged: current !== override.spruceValueAtEdit },
    });
    const restore = { [override.field]: storedToColumn(kind, override.value) };
    if (lineLevel) await db.order.update({ where: { id: override.lineId! }, data: restore });
    else await db.orderDocument.update({ where: { id: documentId }, data: restore });
  }

  await recomputeDerived(db, documentId);
  return true;
}

/** Applies one value to a field, creating or updating its override. */
async function correct(
  db: Db,
  target: { documentId: string; lineId: string | null; field: string; current: StoredValue; value: StoredValue },
  userId: string
): Promise<{ field: string; lineId: string | null; from: StoredValue; to: StoredValue } | null> {
  const key = { documentId: target.documentId, targetKey: targetKeyOf(target.lineId), field: target.field };
  const existing = await db.orderOverride.findUnique({ where: { documentId_targetKey_field: key } });

  if (!existing && target.value === target.current) return null;

  if (existing && target.value === existing.spruceValue) {
    // Set back to what Spruce says: no longer a correction.
    await db.orderOverride.delete({ where: { id: existing.id } });
  } else if (existing) {
    await db.orderOverride.update({
      where: { id: existing.id },
      data: { value: target.value, editedById: userId, editedAt: new Date() },
    });
  } else {
    await db.orderOverride.create({
      data: {
        ...key,
        lineId: target.lineId,
        value: target.value,
        spruceValue: target.current,
        spruceValueAtEdit: target.current,
        editedById: userId,
      },
    });
  }

  const kind = fieldKind(target.field, target.lineId !== null)!;
  const data = { [target.field]: storedToColumn(kind, target.value) };
  if (target.lineId) await db.order.update({ where: { id: target.lineId }, data });
  else await db.orderDocument.update({ where: { id: target.documentId }, data });

  return { field: target.field, lineId: target.lineId, from: target.current, to: target.value };
}

export async function applyOrderEdits(documentId: string, edits: ParsedEdits, userId: string) {
  return prisma.$transaction(async (tx) => {
    const document = await tx.orderDocument.findUnique({
      where: { id: documentId },
      select: { id: true, documentNumber: true, lines: { select: { id: true, product: true, quantity: true } } },
    });
    if (!document) throw new OrderEditError(404, 'That order no longer exists.');
    const row = await tx.orderDocument.findUniqueOrThrow({ where: { id: documentId } });

    const changes = [];
    for (const [field, value] of Object.entries(edits.order) as Array<[OrderField, StoredValue]>) {
      const change = await correct(tx, {
        documentId, lineId: null, field, value, current: columnToStored((row as Record<string, unknown>)[field]),
      }, userId);
      if (change) changes.push(change);
    }

    const lines = new Map(document.lines.map(line => [line.id, line]));
    for (const { lineId, values } of edits.lines) {
      const line = lines.get(lineId);
      if (!line) throw new EditValidationError('That line is not on this order.');
      for (const [field, value] of Object.entries(values) as Array<[LineField, StoredValue]>) {
        const change = await correct(tx, {
          documentId, lineId, field, value, current: columnToStored(line[field]),
        }, userId);
        if (change) changes.push(change);
      }
    }

    if (edits.dispatcherNotes !== undefined && edits.dispatcherNotes !== row.dispatcherNotes) {
      await tx.orderDocument.update({ where: { id: documentId }, data: { dispatcherNotes: edits.dispatcherNotes } });
      changes.push({ field: 'dispatcherNotes', lineId: null, from: row.dispatcherNotes, to: edits.dispatcherNotes });
    }

    if (changes.length > 0) {
      await recomputeDerived(tx, documentId);
      await tx.auditLog.create({
        data: {
          entityType: 'ORDER',
          entityId: documentId,
          actionType: 'ORDER_EDITED',
          performedById: userId,
          details: { documentNumber: document.documentNumber, changes } as Prisma.InputJsonValue,
        },
      });
    }
    return changes;
  });
}

/** Puts Spruce's value back in place of a correction. */
export async function resetOrderEdit(documentId: string, field: string, lineId: string | null, userId: string) {
  return prisma.$transaction(async (tx) => {
    const override = await tx.orderOverride.findUnique({
      where: { documentId_targetKey_field: { documentId, targetKey: targetKeyOf(lineId), field } },
      include: { document: { select: { documentNumber: true } } },
    });
    if (!override) throw new OrderEditError(404, 'That field has no correction to reset.');

    const kind = fieldKind(field, lineId !== null)!;
    const data = { [field]: storedToColumn(kind, override.spruceValue) };
    if (lineId) await tx.order.update({ where: { id: lineId }, data });
    else await tx.orderDocument.update({ where: { id: documentId }, data });
    await tx.orderOverride.delete({ where: { id: override.id } });

    await recomputeDerived(tx, documentId);
    await tx.auditLog.create({
      data: {
        entityType: 'ORDER',
        entityId: documentId,
        actionType: 'ORDER_EDIT_RESET',
        performedById: userId,
        details: {
          documentNumber: override.document.documentNumber,
          field,
          lineId,
          from: override.value,
          to: override.spruceValue,
        } as Prisma.InputJsonValue,
      },
    });
    return { field, lineId, value: override.spruceValue };
  });
}

/**
 * Everything the edit screen shows for one order. No prices or costs: the
 * screen is for what the driver needs, and Spruce owns the money.
 *
 * `updatedFields` and `updates` are what today's uploads changed (America/
 * Toronto), each with what it was, so the screen can say "Updated by today's
 * upload (was …)". A field the dispatcher has corrected is not among them.
 *
 * `awaitingSupplier` names who the order waits on and under which PO, for
 * the "Awaiting supplier" flag. The screen is office-only.
 *
 * @param today 'YYYY-MM-DD' in the yard's timezone; for tests.
 */
export async function getOrderForEditing(idOrNumber: string, today?: string) {
  const byNumber = /^\d{4}-\d{6}$/.test(idOrNumber);
  const document = await prisma.orderDocument.findUnique({
    where: byNumber ? { documentNumber: idOrNumber } : { id: idOrNumber },
    select: {
      id: true,
      documentNumber: true,
      accountCode: true,
      customerName: true,
      phone: true,
      shippingAddress: true,
      addressNormalized: true,
      deliveryInstructions: true,
      deliveryTruck: true,
      deliveryType: true,
      deliveryDate: true,
      dispatcherNotes: true,
      isPickup: true,
      flags: true,
      lines: {
        select: { id: true, product: true, quantity: true, unit: true, spruceItemNumber: true, lineClass: true },
        orderBy: [{ lineNumber: 'asc' }, { id: 'asc' }],
      },
      overrides: {
        select: {
          field: true,
          lineId: true,
          value: true,
          spruceValue: true,
          spruceChanged: true,
          editedAt: true,
          editedBy: { select: { name: true } },
        },
      },
    },
  });
  if (!document) throw new OrderEditError(404, 'That order is not in the system.');

  const [suggestion, changed, awaiting] = await Promise.all([
    addressSuggestion(document),
    updatesForDay(prisma, [document.id], today),
    awaitingSupplierByOrder(prisma, [document]),
  ]);
  const { updatedFields, updates } = changed.get(document.id) ?? NO_UPDATES;
  return {
    ...document,
    addressSuggestion: suggestion,
    updatedFields,
    updates,
    awaitingSupplier: awaiting.get(document.id) ?? [],
  };
}

/**
 * The address this account last had delivered to, offered when an order has
 * none. Trade accounts deliver to the same yards and sites again and again,
 * and twelve of the sixteen sample deliveries arrived with no address. Never
 * for cash sales, where the account is everyone; never filled in silently.
 */
async function addressSuggestion(document: { id: string; accountCode: string | null; shippingAddress: string | null }) {
  if (document.shippingAddress || !document.accountCode || document.accountCode === 'CASH') return null;

  const previous = await prisma.orderDocument.findFirst({
    where: {
      accountCode: document.accountCode,
      id: { not: document.id },
      shippingAddress: { not: null },
      isPickup: false,
    },
    orderBy: [{ deliveryDate: 'desc' }, { updatedAt: 'desc' }],
    select: { documentNumber: true, shippingAddress: true, addressNormalized: true },
  });
  return previous
    ? { address: previous.addressNormalized ?? previous.shippingAddress!, fromOrder: previous.documentNumber }
    : null;
}
