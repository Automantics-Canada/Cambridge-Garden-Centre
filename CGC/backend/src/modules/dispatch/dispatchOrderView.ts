import type { Prisma } from '@prisma/client';

import { classifyLine } from '../orders/import/lineClass.js';
import { updatesForDay } from '../orders/import/orderChanges.js';

/**
 * A Spruce order as the dispatch board draws it.
 *
 * The board was built around single lines — one row each, with a product and
 * a quantity — and its layout stays. A whole order is drawn in the same row:
 * its first product and how many more there are, the total where the products
 * share a unit, and everything a dispatcher checks before choosing a driver.
 *
 * Prices, costs and margins are never selected. This shape reaches drivers'
 * screens through the stops they are given.
 */

/** Everything the board reads off an order, and nothing about money. */
export const DISPATCH_DOCUMENT_SELECT = {
  id: true,
  documentNumber: true,
  customerName: true,
  deliveryDate: true,
  shippingAddress: true,
  addressNormalized: true,
  phone: true,
  deliveryInstructions: true,
  deliveryType: true,
  flags: true,
  dispatcherNotes: true,
  createdAt: true,
  _count: { select: { overrides: true } },
  lines: {
    select: {
      id: true,
      product: true,
      quantity: true,
      unit: true,
      spruceItemNumber: true,
      lineClass: true,
      lineNumber: true,
    },
    orderBy: [{ lineNumber: 'asc' as const }, { id: 'asc' as const }],
  },
} satisfies Prisma.OrderDocumentSelect;

export type DispatchDocument = Prisma.OrderDocumentGetPayload<{ select: typeof DISPATCH_DOCUMENT_SELECT }>;

export interface DispatchLine {
  product: string;
  quantity: number | null;
  unit: string | null;
  itemCode: string | null;
}

/** One PO an order is waiting on, and who it was raised with. */
export interface AwaitingSupplier {
  /**
   * The supplier's name where the line names one, else Spruce's vendor code;
   * null when neither is known. Not `supplier`: that key means the supplier
   * record, which the board's own checks keep out.
   */
  supplierName: string | null;
  poNumber: string;
}

export interface DispatchOrderView {
  /** The order's id. Assigning and unassigning name it. */
  id: string;
  /** Always true: this row is a whole order, not a single line. */
  wholeOrder: true;
  /** The document number, under the name the board already reads. */
  spruceOrderId: string;
  customerName: string;
  /** First product, and how many more: "Garden Soil Bulk +2 more". */
  product: string;
  /** Total of the products where they share a unit, else the first one's. */
  quantity: number | null;
  unit: string | null;
  createdAt: Date;
  deliveryDate: Date | null;
  address: string | null;
  phone: string | null;
  deliveryInstructions: string | null;
  deliveryType: string | null;
  flags: string[];
  dispatcherNotes: string | null;
  /** A dispatcher has corrected something Spruce said. */
  edited: boolean;
  /**
   * Fields Spruce changed in today's uploads, for the "Updated" badge. Empty
   * until `withUpdatedFields` fills it: the changes are read apart from
   * DISPATCH_DOCUMENT_SELECT, which also shapes what drivers are sent.
   */
  updatedFields: string[];
  /**
   * Who the order waits on, and under which PO: "Unilock PO 2608-355356".
   * Office screens only. Absent until `withAwaitingSupplier` fills it, for the
   * same reason as `updatedFields`, and it must never reach a driver.
   */
  awaitingSupplier?: AwaitingSupplier[];
  /** Refundable skids the order ships on. */
  skids: number;
  /** What goes on the truck. Delivery charges, deposits and comments are not. */
  lines: DispatchLine[];
}

const toNumber = (value: Prisma.Decimal | number | null): number | null =>
  value === null ? null : Number(value);

const lineClassOf = (line: DispatchDocument['lines'][number]) =>
  line.lineClass ?? classifyLine(line.spruceItemNumber, line.product);

export function toDispatchOrder(document: DispatchDocument): DispatchOrderView {
  const products = document.lines.filter(line => lineClassOf(line) === 'PRODUCT');
  const skids = document.lines
    .filter(line => lineClassOf(line) === 'DEPOSIT')
    .reduce((sum, line) => sum + (toNumber(line.quantity) ?? 0), 0);

  const units = new Set(products.map(line => line.unit ?? ''));
  const first = products[0];
  const sharedUnit = units.size === 1 && first?.unit ? first.unit : null;
  const quantity = sharedUnit
    ? products.reduce((sum, line) => sum + (toNumber(line.quantity) ?? 0), 0)
    : first ? toNumber(first.quantity) : null;

  return {
    id: document.id,
    wholeOrder: true,
    spruceOrderId: document.documentNumber,
    customerName: document.customerName,
    product: first
      ? products.length > 1 ? `${first.product} +${products.length - 1} more` : first.product
      : 'No products listed',
    quantity,
    unit: sharedUnit ?? first?.unit ?? null,
    createdAt: document.createdAt,
    deliveryDate: document.deliveryDate,
    address: document.addressNormalized ?? document.shippingAddress,
    phone: document.phone,
    deliveryInstructions: document.deliveryInstructions,
    deliveryType: document.deliveryType,
    flags: document.flags,
    dispatcherNotes: document.dispatcherNotes,
    edited: document._count.overrides > 0,
    updatedFields: [],
    skids,
    lines: products.map(line => ({
      product: line.product,
      quantity: toNumber(line.quantity),
      unit: line.unit,
      itemCode: line.spruceItemNumber,
    })),
  };
}

/**
 * The line a stop is filed under, for what still reads stops by line.
 *
 * The first product, so a ticket a driver photographs lands on the material
 * itself rather than on a delivery charge; the first line of any kind for an
 * order with no products.
 */
export function representativeLineId(document: Pick<DispatchDocument, 'lines'>): string | null {
  const product = document.lines.find(line => lineClassOf(line) === 'PRODUCT');
  return (product ?? document.lines[0])?.id ?? null;
}

/** Anything a board response holds whole orders in. */
interface BoardLike {
  carriedOver?: unknown[];
  unassignedOrders?: unknown[];
  drivers?: Array<{ deliveries?: Array<{ order?: unknown }> }>;
}

const isWholeOrder = (row: unknown): row is DispatchOrderView =>
  typeof row === 'object' && row !== null && (row as DispatchOrderView).wholeOrder === true;

/** Every whole order a board response holds: the pool, carried over and each driver's run. */
function wholeOrdersIn(board: BoardLike | unknown[]): DispatchOrderView[] {
  const rows: unknown[] = Array.isArray(board)
    ? board
    : [
        ...(board.carriedOver ?? []),
        ...(board.unassignedOrders ?? []),
        ...(board.drivers ?? []).flatMap(driver => (driver.deliveries ?? []).map(delivery => delivery.order)),
      ];
  return rows.filter(isWholeOrder);
}

/**
 * Marks the orders Spruce changed today, wherever a board response holds
 * them: the pool, carried over, and every driver's run. Takes a list of rows
 * too, for the undated list.
 *
 * One query for the whole board, keyed by order id, rather than a relation on
 * DISPATCH_DOCUMENT_SELECT: that select is also how a driver's stop is read,
 * and the driver's payload must not grow.
 *
 * @param today 'YYYY-MM-DD' in the yard's timezone, America/Toronto
 */
export async function withUpdatedFields<T extends BoardLike | unknown[]>(
  db: Prisma.TransactionClient,
  board: T,
  today?: string
): Promise<T> {
  const orders = wholeOrdersIn(board);
  const updates = await updatesForDay(db, orders.map(order => order.id), today);
  for (const order of orders) order.updatedFields = updates.get(order.id)?.updatedFields ?? [];
  return board;
}

/** A line bought in under a PO, as `awaitingSupplierOf` reads it. */
export interface PoLine {
  poNumber: string | null;
  vendorCode: string | null;
  /** The name of the supplier the line is linked to, or that its vendor code maps to. */
  supplierName: string | null;
}

/**
 * The POs an order waits on, each with who it was raised with, in line order
 * and once each. The supplier is named where the line or its vendor code
 * resolves to one, and is Spruce's vendor code otherwise, so an unmapped
 * vendor still says who to chase.
 */
export function awaitingSupplierOf(lines: PoLine[]): AwaitingSupplier[] {
  const seen = new Set<string>();
  const result: AwaitingSupplier[] = [];
  for (const line of lines) {
    const poNumber = line.poNumber?.trim();
    if (!poNumber) continue;
    const supplierName = line.supplierName?.trim() || line.vendorCode?.trim() || null;
    const key = JSON.stringify([supplierName, poNumber]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ supplierName, poNumber });
  }
  return result;
}

const vendorKey = (code: string) => code.trim().toUpperCase();

/**
 * What each order is waiting on from suppliers, keyed by order id. Only an
 * order flagged AWAITING_SUPPLIER gets entries; the rest get an empty list.
 *
 * Read with its own queries, never through DISPATCH_DOCUMENT_SELECT: that
 * select also shapes what drivers are sent, and who supplies an order is
 * office business. A line's own supplier wins; a line imported before its
 * vendor code was mapped is named through the mapping recorded since.
 */
export async function awaitingSupplierByOrder(
  db: Pick<Prisma.TransactionClient, 'order' | 'supplierSpruceVendor'>,
  orders: Array<{ id: string; flags: string[] }>
): Promise<Map<string, AwaitingSupplier[]>> {
  const result = new Map<string, AwaitingSupplier[]>(orders.map(order => [order.id, []]));
  const ids = [...new Set(orders.filter(order => order.flags.includes('AWAITING_SUPPLIER')).map(order => order.id))];
  if (ids.length === 0) return result;

  const lines = await db.order.findMany({
    where: { documentId: { in: ids }, poNumber: { not: null } },
    select: { documentId: true, poNumber: true, vendorCode: true, supplier: { select: { name: true } } },
    orderBy: [{ lineNumber: 'asc' }, { id: 'asc' }],
  });

  const unnamed = [...new Set(
    lines.filter(line => !line.supplier?.name && line.vendorCode).map(line => vendorKey(line.vendorCode!))
  )];
  const mapped = new Map<string, string>();
  if (unnamed.length > 0) {
    const mappings = await db.supplierSpruceVendor.findMany({
      where: { code: { in: unnamed }, active: true, supplier: { active: true } },
      select: { code: true, supplier: { select: { name: true } } },
    });
    for (const mapping of mappings) mapped.set(vendorKey(mapping.code), mapping.supplier.name);
  }

  for (const id of ids) {
    result.set(id, awaitingSupplierOf(
      lines
        .filter(line => line.documentId === id)
        .map(line => ({
          poNumber: line.poNumber,
          vendorCode: line.vendorCode,
          supplierName: line.supplier?.name ?? (line.vendorCode ? mapped.get(vendorKey(line.vendorCode)) ?? null : null),
        }))
    ));
  }
  return result;
}

/**
 * Names the supplier and PO on every whole order a board response holds, or a
 * list of rows. One read for the whole board, like `withUpdatedFields`.
 */
export async function withAwaitingSupplier<T extends BoardLike | unknown[]>(
  db: Pick<Prisma.TransactionClient, 'order' | 'supplierSpruceVendor'>,
  board: T
): Promise<T> {
  const orders = wholeOrdersIn(board);
  const awaiting = await awaitingSupplierByOrder(db, orders);
  for (const order of orders) order.awaitingSupplier = awaiting.get(order.id) ?? [];
  return board;
}

/**
 * Everything the office board shows beside the rows that drivers must not
 * be sent: what today's upload changed, and which supplier and PO an order
 * waits on.
 *
 * @param today 'YYYY-MM-DD' in the yard's timezone, America/Toronto
 */
export async function withOfficeFields<T extends BoardLike | unknown[]>(
  db: Prisma.TransactionClient,
  board: T,
  today?: string
): Promise<T> {
  await Promise.all([withUpdatedFields(db, board, today), withAwaitingSupplier(db, board)]);
  return board;
}
