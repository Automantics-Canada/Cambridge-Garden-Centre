import type { Prisma } from '@prisma/client';

/**
 * What a dispatcher may correct on an order, and how each value is checked.
 *
 * Spruce is the source of truth for money and identity — the order number,
 * prices, costs, margin — so none of those is here. Everything here is what
 * Spruce often leaves incomplete and the driver needs right: where to go, who
 * to call, what to bring, which day.
 */

export const DELIVERY_TYPES = ['SLINGER', 'SPLITBOX', 'FLATBED', 'DUMP', 'BAG', 'GENERAL'] as const;

type FieldKind = 'text' | 'requiredText' | 'date' | 'deliveryType' | 'quantity';

/** Order fields, by the column each one corrects. */
export const ORDER_FIELDS = {
  customerName: 'requiredText',
  phone: 'text',
  shippingAddress: 'text',
  deliveryInstructions: 'text',
  deliveryTruck: 'text',
  deliveryType: 'deliveryType',
  deliveryDate: 'date',
} as const satisfies Record<string, FieldKind>;

/** Line fields, by the column each one corrects. */
export const LINE_FIELDS = {
  product: 'requiredText',
  quantity: 'quantity',
} as const satisfies Record<string, FieldKind>;

export type OrderField = keyof typeof ORDER_FIELDS;
export type LineField = keyof typeof LINE_FIELDS;

const MAX_TEXT = 1000;

export class EditValidationError extends Error {
  readonly status = 400;
}

/**
 * A value as stored in an override: text, or null for "nothing". Dates are
 * `YYYY-MM-DD` and quantities plain decimals, so Spruce's value and the
 * dispatcher's compare equal whenever they mean the same thing.
 */
export type StoredValue = string | null;

/** A column's current value, in override form. */
export function columnToStored(value: unknown): StoredValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  // A Prisma Decimal, or a number: "12.0000" and 12 are the same quantity.
  if (typeof value === 'object' || typeof value === 'number') return String(Number(value.toString()));
  const text = String(value).trim();
  return text === '' ? null : text;
}

/** Checks one submitted value and returns it in override form. */
export function parseEditValue(field: string, kind: FieldKind, raw: unknown): StoredValue {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    if (kind === 'requiredText' || kind === 'quantity') {
      throw new EditValidationError(`${field} cannot be empty.`);
    }
    return null;
  }

  switch (kind) {
    case 'text':
    case 'requiredText': {
      if (typeof raw !== 'string') throw new EditValidationError(`${field} must be text.`);
      const text = raw.replace(/\s+/g, ' ').trim();
      if (text.length > MAX_TEXT) throw new EditValidationError(`${field} is longer than ${MAX_TEXT} characters.`);
      return text;
    }
    case 'date': {
      if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        throw new EditValidationError(`${field} must be a date like 2026-08-14.`);
      }
      const date = new Date(`${raw}T00:00:00.000Z`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
        throw new EditValidationError(`${raw} is not a real date.`);
      }
      return raw;
    }
    case 'deliveryType': {
      if (typeof raw !== 'string' || !(DELIVERY_TYPES as readonly string[]).includes(raw)) {
        throw new EditValidationError(`${field} must be one of ${DELIVERY_TYPES.join(', ')}.`);
      }
      return raw;
    }
    case 'quantity': {
      const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
      if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) {
        throw new EditValidationError(`${field} must be a positive number.`);
      }
      return String(value);
    }
  }
}

/** An override's value as the column takes it. */
export function storedToColumn(kind: FieldKind, value: StoredValue): string | Date | Prisma.Decimal | null {
  if (value === null) return null;
  if (kind === 'date') return new Date(`${value}T00:00:00.000Z`);
  return value;
}

export interface ParsedEdits {
  order: Partial<Record<OrderField, StoredValue>>;
  lines: Array<{ lineId: string; values: Partial<Record<LineField, StoredValue>> }>;
  /** Present when the request set the dispatcher's note, including to nothing. */
  dispatcherNotes?: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads an edit request: `{ fields, lines, dispatcherNotes }`.
 *
 * Anything not on the lists above is refused by name rather than ignored, so a
 * screen that tries to edit a price learns it cannot instead of believing it
 * did.
 */
export function parseEditRequest(body: unknown): ParsedEdits {
  if (!isRecord(body)) throw new EditValidationError('Send the changes as an object.');
  const parsed: ParsedEdits = { order: {}, lines: [] };

  const fields = body.fields ?? {};
  if (!isRecord(fields)) throw new EditValidationError('fields must be an object.');
  for (const [field, raw] of Object.entries(fields)) {
    const kind = (ORDER_FIELDS as Record<string, FieldKind>)[field];
    if (!kind) throw new EditValidationError(`${field} cannot be edited.`);
    parsed.order[field as OrderField] = parseEditValue(field, kind, raw);
  }

  const lines = body.lines ?? [];
  if (!Array.isArray(lines)) throw new EditValidationError('lines must be a list.');
  for (const line of lines) {
    if (!isRecord(line) || typeof line.id !== 'string') throw new EditValidationError('Each line needs its id.');
    const values: Partial<Record<LineField, StoredValue>> = {};
    for (const [field, raw] of Object.entries(line)) {
      if (field === 'id') continue;
      const kind = (LINE_FIELDS as Record<string, FieldKind>)[field];
      if (!kind) throw new EditValidationError(`A line's ${field} cannot be edited.`);
      values[field as LineField] = parseEditValue(field, kind, raw);
    }
    parsed.lines.push({ lineId: line.id, values });
  }

  if ('dispatcherNotes' in body) {
    parsed.dispatcherNotes = parseEditValue('dispatcherNotes', 'text', body.dispatcherNotes);
  }

  return parsed;
}

export function fieldKind(field: string, lineLevel: boolean): FieldKind | undefined {
  return lineLevel
    ? (LINE_FIELDS as Record<string, FieldKind>)[field]
    : (ORDER_FIELDS as Record<string, FieldKind>)[field];
}

/** The override row's key for an order field or a line's field. */
export const targetKeyOf = (lineId: string | null) => lineId ?? 'ORDER';
