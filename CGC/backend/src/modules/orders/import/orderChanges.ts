import type { Prisma } from '@prisma/client';

import { businessDayOf, businessDayRange } from '../../../lib/businessDay.js';
import { columnToStored, type StoredValue } from '../edits/editableFields.js';

/**
 * What Spruce changed on an order when its reports were uploaded again.
 *
 * The yard may re-run the reports at noon. The import refreshes each order in
 * place and never touches drivers or statuses, so the dispatcher has no way to
 * see that an address or a quantity moved since the morning. Each import now
 * reads the orders it is about to refresh, reads them again afterwards, and
 * logs every tracked field that differs as an `OrderChange`. The board and the
 * order editor mark those fields "Updated" for the rest of the day.
 *
 * Only the fields a driver works from are tracked. Money is Spruce's business
 * and never reaches a driver, so it is not logged here either. A brand-new
 * order has nothing to compare with: it is new, not updated.
 *
 * On a field the dispatcher has corrected, the order's column holds the
 * correction, which an import never changes. What is compared there is
 * Spruce's value, kept on the override, so the log still says what Spruce
 * did; the field is not marked Updated, because what the driver sees did not
 * change. That case is already flagged SPRUCE_VALUE_CHANGED.
 */

/** Order fields whose change is logged, in the order they are listed. */
export const TRACKED_ORDER_FIELDS = [
  'customerName',
  'phone',
  'route',
  'shippingAddress',
  'deliveryInstructions',
  'deliveryTruck',
  'deliveryDate',
  'deliveryType',
] as const;

/** Line fields whose change is logged. */
export const TRACKED_LINE_FIELDS = ['product', 'quantity'] as const;

/** A whole line Spruce added to an order, or took off it. */
export const LINE_ADDED = 'lineAdded';
export const LINE_REMOVED = 'lineRemoved';

export type TrackedOrderField = (typeof TRACKED_ORDER_FIELDS)[number];
export type TrackedLineField = (typeof TRACKED_LINE_FIELDS)[number];

/** Every field name a change can carry, in the order they are shown. */
export const CHANGE_FIELD_ORDER: readonly string[] = [
  ...TRACKED_ORDER_FIELDS,
  ...TRACKED_LINE_FIELDS,
  LINE_ADDED,
  LINE_REMOVED,
];

export interface LineSnapshot {
  id: string;
  product: StoredValue;
  quantity: StoredValue;
  unit: StoredValue;
  /** The log's last word on this line is that Spruce took it off the order. */
  removed: boolean;
}

/** An order's tracked values as Spruce last gave them. */
export interface OrderSnapshot {
  fields: Record<TrackedOrderField, StoredValue>;
  lines: LineSnapshot[];
}

/** Which stored lines this upload's reports printed, and which it created. */
export interface LinesSeen {
  paired: ReadonlySet<string>;
  created: ReadonlySet<string>;
}

export interface ChangeRow {
  lineId: string | null;
  field: string;
  oldValue: StoredValue;
  newValue: StoredValue;
}

/** How a whole line reads in the log: `12 MT 3/4" Clear`. */
export function lineLabel(line: Pick<LineSnapshot, 'product' | 'quantity' | 'unit'>): string {
  return [line.quantity, line.unit, line.product].filter(part => part !== null && part !== '').join(' ');
}

/**
 * The changes between an order before an upload and after it.
 *
 * Pure, so the rules can be tested without a database. A line no report in
 * the upload printed was taken off the order in Spruce; it is never deleted,
 * since it may carry a delivery or a ticket, and is logged once rather than on
 * every later upload that still leaves it out. A line the upload created is a
 * new line; one logged as removed and printed again is back.
 */
export function diffOrder(before: OrderSnapshot, after: OrderSnapshot, seen: LinesSeen): ChangeRow[] {
  const changes: ChangeRow[] = [];

  for (const field of TRACKED_ORDER_FIELDS) {
    if (before.fields[field] !== after.fields[field]) {
      changes.push({ lineId: null, field, oldValue: before.fields[field], newValue: after.fields[field] });
    }
  }

  const afterLines = new Map(after.lines.map(line => [line.id, line]));
  for (const old of before.lines) {
    const now = afterLines.get(old.id);
    if (!now) continue;

    if (!seen.paired.has(old.id)) {
      if (!old.removed) changes.push({ lineId: old.id, field: LINE_REMOVED, oldValue: lineLabel(old), newValue: null });
      continue;
    }
    if (old.removed) {
      changes.push({ lineId: old.id, field: LINE_ADDED, oldValue: null, newValue: lineLabel(now) });
      continue;
    }
    for (const field of TRACKED_LINE_FIELDS) {
      if (old[field] !== now[field]) {
        changes.push({ lineId: old.id, field, oldValue: old[field], newValue: now[field] });
      }
    }
  }

  const known = new Set(before.lines.map(line => line.id));
  for (const line of after.lines) {
    if (seen.created.has(line.id) && !known.has(line.id)) {
      changes.push({ lineId: line.id, field: LINE_ADDED, oldValue: null, newValue: lineLabel(line) });
    }
  }

  return changes;
}

type Db = Prisma.TransactionClient;

interface OverrideKey {
  field: string;
  lineId: string | null;
}

const keyOf = (field: string, lineId: string | null) => `${lineId ?? 'ORDER'}:${field}`;

/** A corrected field or line field: its column holds the dispatcher's value. */
export const isOverridden = (overrides: readonly OverrideKey[], change: Pick<ChangeRow, 'field' | 'lineId'>) =>
  overrides.some(override => override.field === change.field && (override.lineId ?? null) === change.lineId);

/**
 * Each order's tracked values as Spruce last gave them: the column, or the
 * Spruce value kept beside a dispatcher's correction.
 */
export async function snapshotOrders(db: Db, documentIds: string[]): Promise<Map<string, OrderSnapshot>> {
  if (documentIds.length === 0) return new Map();
  const documents = await db.orderDocument.findMany({
    where: { id: { in: documentIds } },
    select: {
      id: true,
      customerName: true,
      phone: true,
      route: true,
      shippingAddress: true,
      deliveryInstructions: true,
      deliveryTruck: true,
      deliveryDate: true,
      deliveryType: true,
      lines: { select: { id: true, product: true, quantity: true, unit: true } },
      overrides: { select: { field: true, lineId: true, spruceValue: true } },
      changes: {
        where: { field: { in: [LINE_ADDED, LINE_REMOVED] } },
        select: { lineId: true, field: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      },
    },
  });

  const snapshots = new Map<string, OrderSnapshot>();
  for (const document of documents) {
    const spruce = (field: string, lineId: string | null, column: unknown): StoredValue => {
      const override = document.overrides.find(o => o.field === field && (o.lineId ?? null) === lineId);
      return override ? override.spruceValue : columnToStored(column);
    };
    const lastWord = new Map<string, string>();
    for (const change of document.changes) if (change.lineId) lastWord.set(change.lineId, change.field);

    const fields = {} as Record<TrackedOrderField, StoredValue>;
    for (const field of TRACKED_ORDER_FIELDS) fields[field] = spruce(field, null, document[field]);

    snapshots.set(document.id, {
      fields,
      lines: document.lines.map(line => ({
        id: line.id,
        product: spruce('product', line.id, line.product),
        quantity: spruce('quantity', line.id, line.quantity),
        unit: columnToStored(line.unit),
        removed: lastWord.get(line.id) === LINE_REMOVED,
      })),
    });
  }
  return snapshots;
}

export interface FieldUpdate {
  field: string;
  lineId: string | null;
  /** What it was before the first change of the day. */
  oldValue: StoredValue;
  /** What the latest upload made it. */
  newValue: StoredValue;
  changedAt: Date;
}

export interface OrderUpdates {
  /** Fields changed by today's uploads, each once, in display order. */
  updatedFields: string[];
  /** Each of them with what it was. */
  updates: FieldUpdate[];
}

export const NO_UPDATES: OrderUpdates = Object.freeze({ updatedFields: [], updates: [] }) as OrderUpdates;

/**
 * One order's changes from today's uploads, as the screens show them.
 *
 * A field changed twice reads as one change, from what it was in the morning
 * to what it is now; one changed and changed back is no change at all. A field
 * the dispatcher has corrected is left out: the driver still sees the
 * correction, and the SPRUCE_VALUE_CHANGED flag says Spruce moved.
 *
 * @param rows the order's changes, oldest first
 */
export function summariseChanges(
  rows: ReadonlyArray<ChangeRow & { createdAt: Date }>,
  overrides: readonly OverrideKey[]
): OrderUpdates {
  const byTarget = new Map<string, FieldUpdate>();
  for (const row of rows) {
    if (isOverridden(overrides, row)) continue;
    const wholeLine = row.field === LINE_ADDED || row.field === LINE_REMOVED;
    const key = wholeLine ? keyOf('line', row.lineId) : keyOf(row.field, row.lineId);
    const first = byTarget.get(key);
    const oldValue = first ? first.oldValue : row.oldValue;
    const field = wholeLine ? (oldValue === null ? LINE_ADDED : LINE_REMOVED) : row.field;
    byTarget.set(key, { field, lineId: row.lineId, oldValue, newValue: row.newValue, changedAt: row.createdAt });
  }

  const rank = (field: string) => {
    const index = CHANGE_FIELD_ORDER.indexOf(field);
    return index === -1 ? CHANGE_FIELD_ORDER.length : index;
  };
  const updates = [...byTarget.values()]
    .filter(update => update.oldValue !== update.newValue)
    .sort((a, b) => rank(a.field) - rank(b.field));

  return { updatedFields: [...new Set(updates.map(update => update.field))], updates };
}

/**
 * Each order's changes from uploads on one business day (America/Toronto),
 * keyed by order id. Orders with none are absent.
 *
 * @param day 'YYYY-MM-DD'; today in the yard by default
 */
export async function updatesForDay(
  db: Db,
  documentIds: string[],
  day: string = businessDayOf()
): Promise<Map<string, OrderUpdates>> {
  const range = businessDayRange(day);
  const ids = [...new Set(documentIds)];
  if (!range || ids.length === 0) return new Map();

  const rows = await db.orderChange.findMany({
    where: { documentId: { in: ids }, createdAt: { gte: range.gte, lte: range.lte } },
    select: { documentId: true, lineId: true, field: true, oldValue: true, newValue: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (rows.length === 0) return new Map();

  const changed = [...new Set(rows.map(row => row.documentId))];
  const overrides = await db.orderOverride.findMany({
    where: { documentId: { in: changed } },
    select: { documentId: true, field: true, lineId: true },
  });

  const result = new Map<string, OrderUpdates>();
  for (const documentId of changed) {
    const summary = summariseChanges(
      rows.filter(row => row.documentId === documentId),
      overrides.filter(override => override.documentId === documentId)
    );
    if (summary.updates.length > 0) result.set(documentId, summary);
  }
  return result;
}
