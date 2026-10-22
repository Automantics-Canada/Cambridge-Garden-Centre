import type { Prisma } from '@prisma/client';
import { classifyFulfilment, type Fulfilment } from './fulfilment.js';

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
  /** The supplier's yard the report names, "Georgetown"; null when it names none. */
  location: string | null;
  poNumber: string;
}

/** One unit's total across an order's products: "2.5 CY". */
export interface QuantityTotal {
  quantity: number;
  unit: string | null;
}

export interface DispatchOrderView {
  /**
   * Where the material is picked up: the suppliers bought from under a PO.
   * Empty means Cambridge Garden Centre's own yard. Set by the office board.
   */
  pickupFrom?: PickupFrom[];
  /** How the goods reach the customer. Set by the office board. */
  fulfilment?: Fulfilment;
  /** The order's id. Assigning and unassigning name it. */
  id: string;
  /** Always true: this row is a whole order, not a single line. */
  wholeOrder: true;
  /** The document number, under the name the board already reads. */
  spruceOrderId: string;
  customerName: string;
  /**
   * First product, and how many other products: "Garden Soil Bulk +2 more".
   * Repeated loads of one item are one product.
   */
  product: string;
  /** The first unit's total; `quantities` has every unit's. */
  quantity: number | null;
  unit: string | null;
  /**
   * Every unit's total, half yards counted as half a yard: one entry where
   * the products share a unit, several where they do not ("2 CY + 4 EA").
   */
  quantities: QuantityTotal[];
  /**
   * Where a pickup is collected when it is not CGC's yard: "Quikrete", read
   * from Spruce's "Pickup direct ... @ Quikrete" comment. Null for the yard.
   */
  collectAt: string | null;
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

/** Spruce's half cubic yard. */
const HALF_YARD = /^hcy$/i;

/**
 * Each unit's total across `lines`, in the order the units first appear.
 * A half-yard line adds half its count to the yards: the yard's "1 HCY" is
 * half a cubic yard of the same material, so 1 CY and 1 HCY are 1.5 CY.
 */
export function quantityTotals(lines: Array<{ quantity: number | null; unit: string | null }>): QuantityTotal[] {
  const totals = new Map<string, QuantityTotal>();
  for (const line of lines) {
    if (line.quantity === null) continue;
    const halfYard = line.unit !== null && HALF_YARD.test(line.unit.trim());
    const unit = halfYard ? 'CY' : line.unit;
    const key = (unit ?? '').toUpperCase();
    const total = totals.get(key) ?? { quantity: 0, unit };
    total.quantity = Number((total.quantity + (halfYard ? line.quantity / 2 : line.quantity)).toFixed(4));
    totals.set(key, total);
  }
  return [...totals.values()];
}

/** Spruce's "**Pickup direct pricing @ Quikrete.**": collected there, not at the yard. */
const PICKUP_DIRECT = /pick\s*-?\s*up\s+direct\b[^@]*@\s*([^*\n]+?)[\s.*]*$/i;

/** The same written as the shipping address: "Pickup Direct at Permacon,". */
const PICKUP_DIRECT_ADDRESS = /^\s*pick\s*-?\s*up\s+direct\s+(?:at|@)\s+([^,\n]+)/i;

/**
 * Where the order's comments, or failing those its shipping address, say it
 * is collected, when that is not the yard.
 */
export function collectAtOf(
  lines: Array<{ product: string; lineClass: string }>,
  shippingAddress?: string | null
): string | null {
  for (const line of lines) {
    if (line.lineClass !== 'COMMENT') continue;
    const place = PICKUP_DIRECT.exec(line.product)?.[1]?.trim();
    if (place) return place;
  }
  return PICKUP_DIRECT_ADDRESS.exec(shippingAddress ?? '')?.[1]?.trim() || null;
}

/**
 * What makes two lines the same product: the item code AND the description,
 * ignoring case and spacing. Never the code alone: catch-all codes such as
 * MISC carry unrelated items (712621 has Quikrete Type S and Corefill Grout,
 * both MISC), so only the description tells them apart. Six AGG01 lines of
 * the same aggregate are still one product (712556).
 */
export function sameProductKey(line: { spruceItemNumber: string | null; product: string }): string {
  const tidy = (text: string | null) => (text ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  return `${tidy(line.spruceItemNumber)}|${tidy(line.product)}`;
}

export function toDispatchOrder(document: DispatchDocument): DispatchOrderView {
  const products = document.lines.filter(line => lineClassOf(line) === 'PRODUCT');
  const skids = document.lines
    .filter(line => lineClassOf(line) === 'DEPOSIT')
    .reduce((sum, line) => sum + (toNumber(line.quantity) ?? 0), 0);

  const quantities = quantityTotals(products.map(line => ({ quantity: toNumber(line.quantity), unit: line.unit })));
  const first = products[0];
  // Six loads of one item on six lines are one product, not six; two items
  // under one catch-all code are two.
  const distinct = new Set(products.map(sameProductKey)).size;

  return {
    id: document.id,
    wholeOrder: true,
    spruceOrderId: document.documentNumber,
    customerName: document.customerName,
    product: first
      ? distinct > 1 ? `${first.product} +${distinct - 1} more` : first.product
      : 'No products listed',
    quantity: quantities[0]?.quantity ?? null,
    unit: quantities[0]?.unit ?? first?.unit ?? null,
    quantities,
    collectAt: collectAtOf(
      document.lines.map(line => ({ product: line.product, lineClass: lineClassOf(line) })),
      document.shippingAddress
    ),
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
  /** The supplier's yard, as the Item Tracking report names it. */
  vendorLocation?: string | null;
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
    const location = line.vendorLocation?.trim() || null;
    const key = JSON.stringify([supplierName, location, poNumber]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ supplierName, location, poNumber });
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
    select: { documentId: true, poNumber: true, vendorCode: true, vendorLocation: true, supplier: { select: { name: true } } },
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
          vendorLocation: line.vendorLocation,
          supplierName: line.supplier?.name ?? (line.vendorCode ? mapped.get(vendorKey(line.vendorCode)) ?? null : null),
        }))
    ));
  }
  return result;
}

/**
 * Where a driver loads an order bought in from a supplier: who, where, and the
 * PO to quote at the counter so the yard hands over the right load and its
 * ticket. Nothing about price.
 */
export interface PickupFrom {
  /** The supplier's name, or Spruce's vendor code where none is mapped. */
  name: string | null;
  /** Which of the supplier's yards, as the Item Tracking report names it: "Georgetown". */
  location: string | null;
  /**
   * The supplier's address on file, where it is that yard's. Left out when
   * the report names a yard the address does not mention: a supplier with
   * several yards has one address on file, and sending a driver to the wrong
   * yard is worse than naming the right one without a street.
   */
  address: string | null;
  po: string;
}

/**
 * The supplier pickups one stop needs, in line order and once each; empty for
 * an order loaded at CGC's own yard, which raises no PO.
 *
 * Deliberately narrow, unlike `awaitingSupplierByOrder`: it is sent to the
 * driver, so it carries the three things a driver needs at the supplier's
 * counter under keys of its own, and the line's supplier record, vendor code
 * and prices never leave the server.
 *
 * @param stop The stop's order, or its single line for a stop made before
 *   orders were dispatched whole.
 */
/** The lines that say where an order is picked up: those bought in on a supplier PO. */
const PICKUP_LINE_SELECT = {
  documentId: true,
  poNumber: true,
  vendorCode: true,
  vendorLocation: true,
  supplier: { select: { name: true, address: true } },
} as const;

type PickupLine = {
  poNumber: string | null;
  vendorCode: string | null;
  vendorLocation: string | null;
  supplier: { name: string; address: string | null } | null;
};

/**
 * Where each order's material is picked up, by order: the suppliers its lines
 * were bought from under a PO. An order with none is picked up at Cambridge
 * Garden Centre's own yard. Read whatever the order's state: the place does
 * not stop mattering once the material has arrived.
 */
export async function pickupFromByDocument(
  db: Pick<Prisma.TransactionClient, 'order' | 'supplierSpruceVendor'>,
  documentIds: string[]
): Promise<Map<string, PickupFrom[]>> {
  const ids = [...new Set(documentIds)];
  const result = new Map<string, PickupFrom[]>(ids.map(id => [id, []]));
  if (ids.length === 0) return result;

  const lines = await db.order.findMany({
    where: { documentId: { in: ids }, poNumber: { not: null } },
    select: PICKUP_LINE_SELECT,
    orderBy: [{ lineNumber: 'asc' }, { id: 'asc' }],
  });
  const suppliers = await suppliersForVendors(db, lines);
  for (const id of ids) {
    result.set(id, pickupPlaces(lines.filter(line => line.documentId === id), suppliers));
  }
  return result;
}

/**
 * Where the driver collects the material for one stop. Prices never come
 * back from this: the driver sees who, which yard and which PO to quote.
 */
export async function pickupFromOf(
  db: Pick<Prisma.TransactionClient, 'order' | 'supplierSpruceVendor'>,
  stop: { documentId: string | null; orderId: string }
): Promise<PickupFrom[]> {
  if (stop.documentId) return (await pickupFromByDocument(db, [stop.documentId])).get(stop.documentId) ?? [];

  const lines = await db.order.findMany({
    where: { id: stop.orderId, poNumber: { not: null } },
    select: PICKUP_LINE_SELECT,
  });
  return pickupPlaces(lines, await suppliersForVendors(db, lines));
}

/**
 * How each order's goods reach the customer (see fulfilment.ts), by order.
 * One read of the orders and their lines for any number of them.
 */
export async function fulfilmentByDocument(
  db: Pick<Prisma.TransactionClient, 'orderDocument' | 'order' | 'supplierSpruceVendor'>,
  documentIds: string[]
): Promise<Map<string, Fulfilment>> {
  const ids = [...new Set(documentIds)];
  const result = new Map<string, Fulfilment>();
  if (ids.length === 0) return result;

  const [documents, lines] = await Promise.all([
    db.orderDocument.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, isPickup: true, shippingAddress: true, deliveryInstructions: true,
        orderNotes: true, deliveryFlag: true, sourceReports: true,
      },
    }),
    db.order.findMany({
      where: { documentId: { in: ids } },
      select: {
        documentId: true, spruceItemNumber: true, product: true, lineClass: true,
        poNumber: true, vendorCode: true, vendorLocation: true,
        supplier: { select: { name: true, address: true } },
      },
      orderBy: [{ lineNumber: 'asc' }, { id: 'asc' }],
    }),
  ]);
  const suppliers = await suppliersForVendors(db, lines);

  for (const document of documents) {
    result.set(document.id, classifyFulfilment({
      ...document,
      lines: lines
        .filter(line => line.documentId === document.id)
        .map(line => {
          const known = line.supplier ?? (line.vendorCode ? suppliers.get(vendorKey(line.vendorCode)) : undefined);
          return {
            itemCode: line.spruceItemNumber,
            description: line.product,
            lineClass: line.lineClass,
            poNumber: line.poNumber,
            vendorCode: line.vendorCode,
            vendorLocation: line.vendorLocation,
            supplierName: known?.name ?? null,
            supplierAddress: known?.address ?? null,
          };
        }),
    }));
  }
  return result;
}

/** The supplier each unlinked line's vendor code is mapped to. */
async function suppliersForVendors(
  db: Pick<Prisma.TransactionClient, 'supplierSpruceVendor'>,
  lines: PickupLine[]
): Promise<Map<string, { name: string; address: string | null }>> {
  const unnamed = [...new Set(
    lines.filter(line => !line.supplier && line.vendorCode).map(line => vendorKey(line.vendorCode!))
  )];
  const mapped = new Map<string, { name: string; address: string | null }>();
  if (unnamed.length === 0) return mapped;
  const mappings = await db.supplierSpruceVendor.findMany({
    where: { code: { in: unnamed }, active: true, supplier: { active: true } },
    select: { code: true, supplier: { select: { name: true, address: true } } },
  });
  for (const mapping of mappings) mapped.set(vendorKey(mapping.code), mapping.supplier);
  return mapped;
}

function pickupPlaces(lines: PickupLine[], mapped: Map<string, { name: string; address: string | null }>): PickupFrom[] {
  const seen = new Set<string>();
  const result: PickupFrom[] = [];
  for (const line of lines) {
    const po = line.poNumber?.trim();
    if (!po) continue;
    const known = line.supplier ?? (line.vendorCode ? mapped.get(vendorKey(line.vendorCode)) : undefined);
    const name = known?.name?.trim() || line.vendorCode?.trim() || null;
    const location = line.vendorLocation?.trim() || null;
    const onFile = known?.address?.trim() || null;
    const address = onFile && (!location || onFile.toLowerCase().includes(location.toLowerCase())) ? onFile : null;
    const key = JSON.stringify([name, location, po]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ name, location, address, po });
  }
  return result;
}

/**
 * Names the supplier and PO on every whole order a board response holds, or a
 * list of rows. One read for the whole board, like `withUpdatedFields`.
 */
export async function withAwaitingSupplier<T extends BoardLike | unknown[]>(
  db: Pick<Prisma.TransactionClient, 'orderDocument' | 'order' | 'supplierSpruceVendor'>,
  board: T
): Promise<T> {
  const orders = wholeOrdersIn(board);
  const [awaiting, pickup, fulfilment] = await Promise.all([
    awaitingSupplierByOrder(db, orders),
    pickupFromByDocument(db, orders.map(order => order.id)),
    fulfilmentByDocument(db, orders.map(order => order.id)),
  ]);
  for (const order of orders) {
    order.awaitingSupplier = awaiting.get(order.id) ?? [];
    order.pickupFrom = pickup.get(order.id) ?? [];
    const how = fulfilment.get(order.id);
    if (how) order.fulfilment = how;
  }
  return withoutDirectShips(board);
}

/**
 * A supplier's own truck delivers a direct ship, so no CGC driver is ever
 * given it: it leaves the board's pools, and stays on the Orders page.
 */
function withoutDirectShips<T extends BoardLike | unknown[]>(board: T): T {
  const kept = (rows: unknown[] | undefined) =>
    rows?.filter(row => !(isWholeOrder(row) && row.fulfilment?.type === 'supplier_direct_ship'));
  if (Array.isArray(board)) {
    const rows = kept(board)!;
    board.splice(0, board.length, ...rows);
    return board;
  }
  if (board.unassignedOrders) board.unassignedOrders = kept(board.unassignedOrders) as typeof board.unassignedOrders;
  if (board.carriedOver) board.carriedOver = kept(board.carriedOver) as typeof board.carriedOver;
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
