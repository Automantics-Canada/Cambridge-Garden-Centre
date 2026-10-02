import type { Prisma } from '@prisma/client';

import { classifyLine } from '../orders/import/lineClass.js';

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
