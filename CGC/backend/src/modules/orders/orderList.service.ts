import type { DeliveryStatus, Prisma } from '@prisma/client';

import { prisma } from '../../db/prisma.js';
import { endOfBusinessDay, startOfBusinessDay } from '../../lib/businessDay.js';
import {
  DISPATCH_DOCUMENT_SELECT,
  awaitingSupplierByOrder,
  toDispatchOrder,
  type AwaitingSupplier,
  type DispatchOrderView,
} from '../dispatch/dispatchOrderView.js';

/**
 * The Orders page: one row per Spruce order, as the three reports merged it.
 *
 * The page used to list single lines, so one order with four products was
 * four rows, and nothing on it said what the import found missing or whether
 * the order had gone out. This lists whole orders, with the import's flags
 * and the stop's status, the same order the dispatch board and the editor
 * work on.
 */

/** 400 rather than 500: the request was wrong, not the server. */
function badRequest(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}

/** Stops in these states are over, one way or the other. */
const FINISHED: DeliveryStatus[] = ['DELIVERED', 'CANCELLED'];
/** A driver has the order on the truck. */
const ON_THE_WAY: DeliveryStatus[] = ['OUT_FOR_DELIVERY', 'IN_TRANSIT'];

/**
 * The delivery-status filter, in the words on the page. Pickups never get a
 * stop, so they count as not assigned and not delivered.
 */
export const DELIVERY_STATUS_FILTERS = {
  /** Anything still to do: not delivered and not cancelled. */
  pending: {
    OR: [{ delivery: { is: null } }, { delivery: { is: { status: { notIn: FINISHED } } } }],
  },
  /** Nobody is taking it yet. */
  unassigned: {
    OR: [{ delivery: { is: null } }, { delivery: { is: { driverId: null, status: { notIn: FINISHED } } } }],
  },
  /** On a driver's run, not started. */
  assigned: {
    delivery: { is: { driverId: { not: null }, status: { notIn: [...FINISHED, ...ON_THE_WAY] } } },
  },
  onTheWay: { delivery: { is: { status: { in: ON_THE_WAY } } } },
  delivered: { delivery: { is: { status: 'DELIVERED' } } },
  cancelled: { delivery: { is: { status: 'CANCELLED' } } },
} satisfies Record<string, Prisma.OrderDocumentWhereInput>;

export type DeliveryStatusFilter = keyof typeof DELIVERY_STATUS_FILTERS;

/** The board's order shape, plus what the office reads and a driver never sees. */
const LIST_SELECT = {
  ...DISPATCH_DOCUMENT_SELECT,
  isPickup: true,
  poNumber: true,
  buyerType: true,
  lastBatch: { select: { createdAt: true } },
  delivery: {
    select: {
      status: true,
      driver: { select: { id: true, name: true, companyName: true } },
    },
  },
  lines: {
    select: {
      ...DISPATCH_DOCUMENT_SELECT.lines.select,
      poNumber: true,
      hasInvoice: true,
      _count: { select: { ticketMatches: true } },
    },
    orderBy: DISPATCH_DOCUMENT_SELECT.lines.orderBy,
  },
} satisfies Prisma.OrderDocumentSelect;

type ListedDocument = Prisma.OrderDocumentGetPayload<{ select: typeof LIST_SELECT }>;

export interface OrderListRow extends DispatchOrderView {
  isPickup: boolean;
  buyerType: string | null;
  /** The order's PO and every line's, once each. */
  poNumbers: string[];
  /** When an upload last described the order: today's re-upload, or its first import. */
  uploadedAt: Date;
  /** The stop, once the order has one. Null for pickups and orders never assigned. */
  delivery: { status: DeliveryStatus; driverName: string | null } | null;
  /** Lines invoiced out of the lines there are. */
  invoicedLines: number;
  lineCount: number;
  /** Tickets matched to any of the order's lines. */
  ticketCount: number;
}

function toRow(document: ListedDocument, awaiting: AwaitingSupplier[]): OrderListRow {
  const poNumbers = [...new Set(
    [document.poNumber, ...document.lines.map(line => line.poNumber)]
      .map(po => po?.trim())
      .filter((po): po is string => Boolean(po))
  )];
  const driver = document.delivery?.driver;
  return {
    ...toDispatchOrder(document),
    awaitingSupplier: awaiting,
    isPickup: document.isPickup,
    buyerType: document.buyerType,
    poNumbers,
    uploadedAt: document.lastBatch?.createdAt ?? document.createdAt,
    delivery: document.delivery
      ? {
          status: document.delivery.status,
          driverName: driver ? (driver.companyName ? `${driver.name} (${driver.companyName})` : driver.name) : null,
        }
      : null,
    invoicedLines: document.lines.filter(line => line.hasInvoice).length,
    lineCount: document.lines.length,
    ticketCount: document.lines.reduce((sum, line) => sum + line._count.ticketMatches, 0),
  };
}

const yes = (value: unknown) => value === 'true' || value === true;

export function buildOrderListWhere(filters: Record<string, any>): Prisma.OrderDocumentWhereInput {
  const { uploadStartDate, uploadEndDate, fulfilment, deliveryStatus, buyerType, hasInvoice, hasLinkedTickets, supplierId, driverId, search } = filters;
  const and: Prisma.OrderDocumentWhereInput[] = [];

  // Uploaded that day means first imported that day, or described again by
  // that day's reports: a re-upload updates the order and keeps `createdAt`.
  // The days are Cambridge's, not UTC's.
  if (uploadStartDate || uploadEndDate) {
    const range: { gte?: Date; lte?: Date } = {};
    if (uploadStartDate) {
      const gte = startOfBusinessDay(String(uploadStartDate));
      if (!gte) throw badRequest(`Invalid uploadStartDate: ${uploadStartDate}`);
      range.gte = gte;
    }
    if (uploadEndDate) {
      const lte = endOfBusinessDay(String(uploadEndDate));
      if (!lte) throw badRequest(`Invalid uploadEndDate: ${uploadEndDate}`);
      range.lte = lte;
    }
    if (range.gte && range.lte && range.gte > range.lte) {
      throw badRequest('uploadStartDate is after uploadEndDate');
    }
    and.push({ OR: [{ createdAt: range }, { lastBatch: { is: { createdAt: range } } }] });
  }

  if (fulfilment === 'pickup') and.push({ isPickup: true });
  else if (fulfilment === 'delivery') and.push({ isPickup: false });
  else if (fulfilment) throw badRequest(`Invalid fulfilment: ${fulfilment}`);

  if (deliveryStatus) {
    const filter = DELIVERY_STATUS_FILTERS[deliveryStatus as DeliveryStatusFilter];
    if (!filter) throw badRequest(`Invalid deliveryStatus: ${deliveryStatus}`);
    and.push(filter);
  }

  if (buyerType) and.push({ buyerType });
  if (driverId) and.push({ delivery: { is: { driverId: String(driverId) } } });
  if (supplierId) and.push({ lines: { some: { supplierId: String(supplierId) } } });

  // "Has invoice" means every line is invoiced; "no" means some line is not.
  if (hasInvoice !== undefined && hasInvoice !== '') {
    and.push(yes(hasInvoice)
      ? { lines: { some: {}, every: { hasInvoice: true } } }
      : { lines: { some: { hasInvoice: false } } });
  }
  if (hasLinkedTickets !== undefined && hasLinkedTickets !== '') {
    and.push(yes(hasLinkedTickets)
      ? { lines: { some: { ticketMatches: { some: {} } } } }
      : { lines: { none: { ticketMatches: { some: {} } } } });
  }

  const term = typeof search === 'string' ? search.trim() : '';
  if (term) {
    const contains = { contains: term, mode: 'insensitive' as const };
    and.push({
      OR: [
        { documentNumber: contains },
        { customerName: contains },
        { poNumber: contains },
        { shippingAddress: contains },
        { phone: contains },
        { lines: { some: { OR: [{ product: contains }, { poNumber: contains }, { spruceOrderId: contains }] } } },
      ],
    });
  }

  return and.length > 0 ? { AND: and } : {};
}

export async function listOrders(filters: Record<string, any>) {
  const where = buildOrderListWhere(filters);
  const take = Math.min(Math.max(parseInt(filters.limit, 10) || 30, 1), 100);
  const page = Math.max(parseInt(filters.page, 10) || 1, 1);

  const [documents, total] = await Promise.all([
    prisma.orderDocument.findMany({
      where,
      select: LIST_SELECT,
      // Spruce numbers its orders in sequence, so this is newest first.
      orderBy: { documentNumber: 'desc' },
      take,
      skip: (page - 1) * take,
    }),
    prisma.orderDocument.count({ where }),
  ]);

  const awaiting = await awaitingSupplierByOrder(prisma, documents);

  return {
    data: documents.map(document => toRow(document, awaiting.get(document.id) ?? [])),
    pagination: { total, page, limit: take, totalPages: Math.max(1, Math.ceil(total / take)) },
  };
}
