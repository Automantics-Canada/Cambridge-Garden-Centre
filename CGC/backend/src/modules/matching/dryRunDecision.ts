/**
 * What the matching engine would decide for an invoice line, without storing
 * anything.
 *
 * Built for the sample invoices the client sends us before go-live (A13).
 * Those must never enter production, and most of them are probably already
 * paid, so the only safe way to see what the app would make of them is to
 * run the same pure decisions against records that are handed in: a JSON
 * file of the related orders, tickets and rates written by hand from the
 * Spruce numbers the client gives us, or the same rows read from a
 * disposable loopback database (scripts/sampleDryRun/loopbackRecords.ts).
 *
 * Nothing here reads or writes a database. It composes what production
 * already uses: matchInvoiceLine for a material line's verdict, matchHaulLine
 * for a trucking company's line (checked against the dispatch loads it
 * bills), deriveLineItemFlag for the one-word flag. The selection of which rows to hand the engine mirrors the
 * queries in matching.service.ts (matchInvoiceLineById), and the supplier
 * lookup and stored-line values mirror invoice.service.ts and
 * supplier.service.ts. Those are written against the database and cannot be
 * called without one; where they change, change the mirror here too.
 */
import { LineItemFlag, SupplierType, TicketSource } from '@prisma/client';
import { compareTwoStrings } from 'string-similarity';
import { z } from 'zod';
import { deriveLineItemFlag } from '../../lib/lineItemFlag.js';
import {
  matchInvoiceLine,
  type AgreedRate,
  type CandidateOrder,
  type CompetingLine,
  type DeliveredTicket,
  type MatchDecision,
  type ProductAlias,
} from './matchEngine.js';
import { matchHaulLine, type CandidateLoad, type CompetingHaulLine } from './haulMatch.js';
import { onSamePo, poKey } from './poKey.js';
import { DEFAULT_HAUL_TOLERANCES, DEFAULT_TOLERANCES, type HaulTolerances, type Tolerances } from './tolerances.js';

// ---------------------------------------------------------------------------
// The related records, as written by hand (related.json) or read from a
// loopback database. Suppliers are referred to by id or by name, so a person
// writing the file does not have to invent ids for everything.
// ---------------------------------------------------------------------------

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'dates are written YYYY-MM-DD');

const SupplierRefSchema = z.string().min(1);

export const RelatedRecordsFileSchema = z.object({
  /** Free text for the person reading the file; ignored. */
  notes: z.string().optional(),
  tolerances: z
    .object({
      quantityTolerancePct: z.number().min(0).max(100).optional(),
      dateWindowDays: z.number().min(0).max(100).optional(),
      priceTolerancePct: z.number().min(0).max(100).optional(),
      haulPriceTolerancePct: z.number().min(0).max(100).optional(),
      haulDateWindowDays: z.number().min(0).max(100).optional(),
      haulQuantityReviewPct: z.number().min(0).max(1000).optional(),
    })
    .optional(),
  suppliers: z
    .array(
      z.object({
        id: z.string().min(1).optional(),
        name: z.string().min(1),
        type: z.enum(['SUPPLIER', 'TRUCKING_COMPANY']).default('SUPPLIER'),
        active: z.boolean().default(true),
      })
    )
    .default([]),
  aliases: z
    .array(z.object({ supplier: SupplierRefSchema, aliasText: z.string().min(1), productName: z.string().min(1) }))
    .default([]),
  orders: z
    .array(
      z.object({
        id: z.string().min(1).optional(),
        /** The Spruce document number, for the report only. */
        orderNumber: z.string().optional(),
        poNumber: z.string().nullable().default(null),
        product: z.string().min(1),
        quantity: z.number().nullable().default(null),
        unit: z.string().nullable().default(null),
        supplier: SupplierRefSchema.nullable().default(null),
        orderDate: isoDate.nullable().default(null),
        deliveryDate: isoDate.nullable().default(null),
        spruceItemNumber: z.string().nullable().default(null),
        /** A quotation's line: never a candidate, as in production. */
        quote: z.boolean().default(false),
      })
    )
    .default([]),
  tickets: z
    .array(
      z.object({
        id: z.string().min(1).optional(),
        ticketNumber: z.string().nullable().default(null),
        poNumber: z.string().nullable().default(null),
        quantity: z.number().nullable().default(null),
        unit: z.string().nullable().default(null),
        material: z.string().nullable().default(null),
        supplier: SupplierRefSchema.nullable().default(null),
        ticketDate: isoDate.nullable().default(null),
        /** MANUAL or WHATSAPP is a driver's or the office's copy; EMAIL is the supplier's. */
        source: z.enum(['MANUAL', 'WHATSAPP', 'EMAIL']).default('MANUAL'),
        /** The id of the copy that counts, when this is a second copy of a load. */
        duplicateOf: z.string().nullable().default(null),
        /** Set when the load has already been paid on another invoice line. */
        claimedBy: z
          .object({ invoiceNumber: z.string(), lineNumber: z.number().int().positive() })
          .nullable()
          .default(null),
      })
    )
    .default([]),
  rates: z
    .array(
      z.object({
        supplier: SupplierRefSchema,
        productName: z.string().min(1),
        rate: z.number(),
        unit: z.string().min(1),
        effectiveFrom: isoDate,
        effectiveTo: isoDate.nullable().default(null),
        spruceItemCode: z.string().nullable().default(null),
        supplierItemCode: z.string().nullable().default(null),
      })
    )
    .default([]),
  /**
   * The loads dispatch recorded, with the haul rate set on each (client, Q14).
   * A trucking company's sample lines are checked against these, not against
   * orders and tickets. One entry per load, as the dispatch board lists them.
   */
  dispatchLoads: z
    .array(
      z.object({
        id: z.string().min(1).optional(),
        /** The Spruce order the load was for. */
        orderNumber: z.string().min(1),
        sequence: z.number().int().positive().default(1),
        /** The trucking company that hauled it. CGC's own trucks bill nobody and are left out. */
        carrier: SupplierRefSchema,
        rate: z.number().min(0).nullable().default(null),
        rateUnit: z.enum(['LOAD', 'HOUR', 'TONNE']).nullable().default(null),
        /** What dispatch expected: hours or tonnes, or 1 load. */
        quantity: z.number().positive().nullable().default(null),
        /** Loads of one brokered trip share it; each load is still paid once. */
        tripRef: z.string().nullable().default(null),
        ticketNumber: z.string().nullable().default(null),
        /** The day it was hauled: the order's delivery date, or the day the stop was done. */
        haulDate: isoDate,
        /** The order's POs; the orders list's POs for this order number are added. */
        poNumbers: z.array(z.string()).default([]),
        /** Numbers of the drivers' tickets linked to the order. */
        orderTicketNumbers: z.array(z.string()).default([]),
        /** Set when another invoice line has already paid this load. */
        claimedBy: z
          .object({ invoiceNumber: z.string(), lineNumber: z.number().int().positive() })
          .nullable()
          .default(null),
      })
    )
    .default([]),
  /** Other invoices' lines on file that nobody has ruled on yet. */
  openInvoiceLines: z
    .array(
      z.object({
        id: z.string().min(1).optional(),
        invoiceNumber: z.string().min(1),
        lineNumber: z.number().int().positive(),
        poNumber: z.string().nullable().default(null),
        supplier: SupplierRefSchema.nullable().default(null),
        invoiceDate: isoDate.nullable().default(null),
        /** For a trucking company's line: the ids of the dispatch loads its verdict counts. */
        loads: z.array(z.string()).default([]),
      })
    )
    .default([]),
});
export type RelatedRecordsFile = z.input<typeof RelatedRecordsFileSchema>;

export interface RelatedSupplier {
  id: string;
  name: string;
  type: SupplierType;
  active: boolean;
}

export interface RelatedOrder extends CandidateOrder {
  orderNumber: string | null;
  quote: boolean;
}

export interface RelatedTicket extends DeliveredTicket {
  source: TicketSource;
}

export interface RelatedRate extends AgreedRate {
  supplierId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface RelatedInvoiceLine extends CompetingLine {
  poNumber: string | null;
  supplierId: string | null;
  /** The dispatch loads a trucking line's verdict counts; empty for a material line. */
  loadIds: string[];
}

/** Everything the engine may be shown, already resolved to ids and dates. */
export interface RelatedRecords {
  tolerances: Tolerances;
  haulTolerances: HaulTolerances;
  suppliers: RelatedSupplier[];
  aliases: ProductAlias[];
  orders: RelatedOrder[];
  tickets: RelatedTicket[];
  rates: RelatedRate[];
  /** Dispatch loads by trucking companies, as the haul matcher reads them. */
  loads: CandidateLoad[];
  openInvoiceLines: RelatedInvoiceLine[];
}

export function emptyRelatedRecords(): RelatedRecords {
  return {
    tolerances: { ...DEFAULT_TOLERANCES },
    haulTolerances: { ...DEFAULT_HAUL_TOLERANCES },
    loads: [],
    suppliers: [],
    aliases: [],
    orders: [],
    tickets: [],
    rates: [],
    openInvoiceLines: [],
  };
}

function utcDate(value: string | null): Date | null {
  if (value === null) return null;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`${value} is not a real date`);
  }
  return date;
}

/**
 * Reads a hand-written related.json into records the engine can take.
 *
 * Refuses anything ambiguous rather than guessing: a supplier reference that
 * names no supplier, or two suppliers, is an error with the reference in it.
 */
export function parseRelatedRecords(input: unknown): RelatedRecords {
  const file = RelatedRecordsFileSchema.parse(input);

  const suppliers: RelatedSupplier[] = file.suppliers.map((supplier, index) => ({
    id: supplier.id ?? `supplier-${index + 1}`,
    name: supplier.name,
    type: supplier.type === 'TRUCKING_COMPANY' ? SupplierType.TRUCKING_COMPANY : SupplierType.SUPPLIER,
    active: supplier.active,
  }));
  const ids = new Set<string>();
  for (const supplier of suppliers) {
    if (ids.has(supplier.id)) throw new Error(`Two suppliers have the id "${supplier.id}"`);
    ids.add(supplier.id);
  }

  const supplierId = (ref: string | null, where: string): string | null => {
    if (ref === null) return null;
    if (ids.has(ref)) return ref;
    const byName = suppliers.filter((supplier) => supplier.name.toLowerCase() === ref.trim().toLowerCase());
    if (byName.length === 1) return byName[0]!.id;
    throw new Error(
      byName.length === 0
        ? `${where}: supplier "${ref}" is not in the suppliers list`
        : `${where}: "${ref}" names ${byName.length} suppliers; use its id`
    );
  };

  const orders: RelatedOrder[] = file.orders.map((order, index) => ({
    id: order.id ?? `order-${index + 1}`,
    orderNumber: order.orderNumber ?? null,
    poNumber: order.poNumber,
    product: order.product,
    quantity: order.quantity,
    unit: order.unit,
    supplierId: supplierId(order.supplier, `orders[${index}]`),
    orderDate: utcDate(order.orderDate),
    deliveryDate: utcDate(order.deliveryDate),
    spruceItemNumber: order.spruceItemNumber,
    quote: order.quote,
  }));

  const tickets: RelatedTicket[] = file.tickets.map((ticket, index) => ({
    id: ticket.id ?? `ticket-${index + 1}`,
    ticketNumber: ticket.ticketNumber,
    poNumber: ticket.poNumber,
    quantity: ticket.quantity,
    unit: ticket.unit,
    material: ticket.material,
    supplierId: supplierId(ticket.supplier, `tickets[${index}]`),
    ticketDate: utcDate(ticket.ticketDate),
    source: TicketSource[ticket.source],
    emailedBySupplier: ticket.source === 'EMAIL',
    duplicateOfTicketId: ticket.duplicateOf,
    claim: ticket.claimedBy
      ? {
          invoiceLineId: `on-file:${ticket.claimedBy.invoiceNumber}#${ticket.claimedBy.lineNumber}`,
          invoiceNumber: ticket.claimedBy.invoiceNumber,
          lineNumber: ticket.claimedBy.lineNumber,
          claimedByName: null,
          claimedAt: new Date(0),
        }
      : null,
  }));
  const ticketIds = new Set(tickets.map((ticket) => ticket.id));
  for (const ticket of tickets) {
    if (ticket.duplicateOfTicketId && !ticketIds.has(ticket.duplicateOfTicketId)) {
      throw new Error(`Ticket ${ticket.id} is a copy of "${ticket.duplicateOfTicketId}", which is not in the tickets list`);
    }
  }

  const loads: CandidateLoad[] = file.dispatchLoads.map((load, index) => {
    const where = `dispatchLoads[${index}]`;
    const carrierSupplierId = supplierId(load.carrier, where)!;
    // As the loads service refuses it: a carrier is a trucking company, and
    // a rate always says what it is per.
    if (suppliers.find((supplier) => supplier.id === carrierSupplierId)?.type !== SupplierType.TRUCKING_COMPANY) {
      throw new Error(`${where}: carrier "${load.carrier}" is not a TRUCKING_COMPANY supplier`);
    }
    if (load.rate !== null && load.rateUnit === null) {
      throw new Error(`${where}: say whether the rate is per LOAD, HOUR or TONNE (rateUnit)`);
    }
    const sameOrder = orders.filter((order) => order.orderNumber === load.orderNumber);
    return {
      id: load.id ?? `load-${index + 1}`,
      documentId: `order:${load.orderNumber}`,
      sequence: load.sequence,
      carrierSupplierId,
      tripRef: load.tripRef,
      rate: load.rate === null ? null : String(load.rate),
      rateUnit: load.rateUnit,
      quantity: load.quantity === null ? null : String(load.quantity),
      claimedByLineItemId: load.claimedBy ? `on-file:${load.claimedBy.invoiceNumber}#${load.claimedBy.lineNumber}` : null,
      documentNumber: load.orderNumber,
      haulDate: utcDate(load.haulDate)!,
      ticketNumber: load.ticketNumber,
      poNumbers: [...new Set([...load.poNumbers, ...sameOrder.flatMap((order) => (order.poNumber ? [order.poNumber] : []))])],
      orderTicketNumbers: load.orderTicketNumbers,
      orderLineId: sameOrder[0]?.id ?? null,
      claim: load.claimedBy ? { invoiceNumber: load.claimedBy.invoiceNumber, lineNumber: load.claimedBy.lineNumber } : null,
    };
  });
  const loadIds = new Set<string>();
  for (const load of loads) {
    if (loadIds.has(load.id)) throw new Error(`Two dispatch loads have the id "${load.id}"`);
    loadIds.add(load.id);
  }

  const tolerances = stripUndefined(file.tolerances ?? {});
  return {
    tolerances: {
      ...DEFAULT_TOLERANCES,
      ...stripUndefined({
        quantityTolerancePct: tolerances.quantityTolerancePct,
        dateWindowDays: tolerances.dateWindowDays,
        priceTolerancePct: tolerances.priceTolerancePct,
      }),
    },
    haulTolerances: {
      ...DEFAULT_HAUL_TOLERANCES,
      ...stripUndefined({
        haulPriceTolerancePct: tolerances.haulPriceTolerancePct,
        haulDateWindowDays: tolerances.haulDateWindowDays,
        haulQuantityReviewPct: tolerances.haulQuantityReviewPct,
      }),
    },
    loads,
    suppliers,
    aliases: file.aliases.map((alias, index) => ({
      supplierId: supplierId(alias.supplier, `aliases[${index}]`)!,
      aliasText: alias.aliasText,
      productName: alias.productName,
    })),
    orders,
    tickets,
    rates: file.rates.map((rate, index) => ({
      supplierId: supplierId(rate.supplier, `rates[${index}]`)!,
      productName: rate.productName,
      rate: rate.rate,
      unit: rate.unit,
      effectiveFrom: utcDate(rate.effectiveFrom)!,
      effectiveTo: utcDate(rate.effectiveTo),
      spruceItemCode: rate.spruceItemCode,
      supplierItemCode: rate.supplierItemCode,
    })),
    openInvoiceLines: file.openInvoiceLines.map((line, index) => ({
      invoiceLineId: line.id ?? `open-line-${index + 1}`,
      invoiceNumber: line.invoiceNumber,
      lineNumber: line.lineNumber,
      invoiceDate: utcDate(line.invoiceDate),
      poNumber: line.poNumber,
      supplierId: supplierId(line.supplier, `openInvoiceLines[${index}]`),
      loadIds: line.loads,
    })),
  };
}

function stripUndefined<T extends object>(value: T): Partial<{ [K in keyof T]: Exclude<T[K], undefined> }> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<{
    [K in keyof T]: Exclude<T[K], undefined>;
  }>;
}

// ---------------------------------------------------------------------------
// Which supplier an invoice lands under.
// ---------------------------------------------------------------------------

export type SupplierResolution =
  | { how: 'exact' | 'contains' | 'fuzzy'; supplier: RelatedSupplier; similarity?: number }
  /** Production would create a new supplier with this name. */
  | { how: 'would-create'; name: string; bestGuess: { name: string; similarity: number } | null }
  | { how: 'none' };

/**
 * The supplier production files an invoice under for this printed name.
 *
 * Mirrors SupplierService.findOrCreateSupplier, minus the create: an exact
 * name (case ignored), then a supplier whose name contains this one, then the
 * closest active supplier above a 0.75 similarity. Where production would
 * create a new supplier, this says so, because a sample that does that is
 * the clearest sign a supplier's name needs registering before go-live: the
 * new supplier has no orders and no rates, so every line would fail.
 */
export function resolveSupplierLikeProduction(
  name: string | null,
  suppliers: readonly RelatedSupplier[]
): SupplierResolution {
  const trimmed = name?.trim() ?? '';
  if (!trimmed) return { how: 'none' };
  const lower = trimmed.toLowerCase();

  const exact = suppliers.find((supplier) => supplier.name.toLowerCase() === lower);
  if (exact) return { how: 'exact', supplier: exact };

  const contains = suppliers.find((supplier) => supplier.name.toLowerCase().includes(lower));
  if (contains) return { how: 'contains', supplier: contains };

  let best: RelatedSupplier | null = null;
  let highest = 0;
  for (const supplier of suppliers) {
    if (!supplier.active) continue;
    const similarity = compareTwoStrings(lower, supplier.name.toLowerCase());
    if (similarity > highest) {
      highest = similarity;
      best = supplier;
    }
  }
  if (best && highest > 0.75) return { how: 'fuzzy', supplier: best, similarity: Number(highest.toFixed(3)) };

  return {
    how: 'would-create',
    name: trimmed,
    bestGuess: best ? { name: best.name, similarity: Number(highest.toFixed(3)) } : null,
  };
}

// ---------------------------------------------------------------------------
// One invoice line.
// ---------------------------------------------------------------------------

/** An invoice line as the reader returned it. */
export interface ReadLine {
  description: string;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
  poNumber: string | null;
  /** The ticket or load number printed on the line (trucking invoices). */
  ticketNumber?: string | null;
  /** The day the line says the haul ran (trucking invoices). */
  serviceDate?: Date | null;
}

/** The line as production writes it to InvoiceLineItem, which is what the engine then reads back. */
export interface StoredLine {
  lineNumber: number;
  description: string;
  poNumber: string | null;
  quantity: number;
  unit: string;
  unitRate: number;
  lineTotal: number;
  ticketNumber: string | null;
  serviceDate: Date | null;
}

/**
 * The values production stores for a line read off an invoice.
 *
 * Mirrors pass one of InvoiceService.processInvoiceOcr. Note what it does to
 * a value the reader could not see: an unread quantity or price is stored as
 * 0, and an unread unit as "unknown". The engine is judged on those stored
 * values, so the preview is too, and the report says which were unread.
 */
export function storedLineLikeProduction(item: ReadLine, index: number, invoicePo: string | null): StoredLine {
  const quantity = Number(item.quantity) || 0;
  const unitRate = Number(item.unitPrice) || 0;
  return {
    lineNumber: index + 1,
    description: item.description || 'Unknown Item',
    poNumber: item.poNumber || invoicePo || null,
    quantity,
    unit: item.unit ?? 'unknown',
    unitRate,
    lineTotal: Number(item.totalPrice) || quantity * unitRate,
    ticketNumber: item.ticketNumber ?? null,
    serviceDate: item.serviceDate ?? null,
  };
}

/** Whether a stored PO could be this one: the database's wide net, before the engine narrows on the key. */
function couldBePo(stored: string | null, poNumber: string): boolean {
  if (stored === null) return false;
  if (stored === poNumber) return true;
  const key = poKey(poNumber);
  return key !== null && stored.includes(key.suffix);
}

function within(date: Date, from: Date, to: Date): boolean {
  return date.getTime() >= from.getTime() && date.getTime() <= to.getTime();
}

export interface LineInputs {
  orders: CandidateOrder[];
  aliases: ProductAlias[];
  tickets: DeliveredTicket[];
  agreedRates: AgreedRate[];
  competingLines: CompetingLine[];
  tolerances: Tolerances;
}

/**
 * The rows production would hand the engine for this line.
 *
 * Mirrors matchInvoiceLineById and its loaders: orders on the PO or from the
 * supplier within the date window (never a quotation's); the supplier's
 * aliases; tickets on the PO from this supplier or with no supplier read,
 * plus every other copy of those loads; the supplier's rates in force on the
 * invoice date; and other invoices' unsettled lines on the same PO.
 */
export function selectLineInputs(
  line: StoredLine,
  supplierId: string | null,
  invoiceDate: Date | null,
  records: RelatedRecords
): LineInputs {
  const window = records.tolerances.dateWindowDays * 86_400_000;
  const po = line.poNumber;

  const orders = records.orders.filter((order) => {
    if (order.quote) return false;
    if (po && couldBePo(order.poNumber, po)) return true;
    if (!supplierId || !invoiceDate || order.supplierId !== supplierId) return false;
    const from = new Date(invoiceDate.getTime() - window);
    const to = new Date(invoiceDate.getTime() + window);
    if (order.orderDate) return within(order.orderDate, from, to);
    return order.deliveryDate !== null && order.deliveryDate !== undefined && within(order.deliveryDate, from, to);
  });

  const onPo = po
    ? records.tickets.filter(
        (ticket) =>
          couldBePo(ticket.poNumber, po) &&
          (supplierId === null || ticket.supplierId === supplierId || ticket.supplierId === null)
      )
    : [];
  const loaded = new Set(onPo.map((ticket) => ticket.id));
  const roots = new Set(onPo.map((ticket) => ticket.duplicateOfTicketId ?? ticket.id));
  const twins = onPo.length === 0
    ? []
    : records.tickets.filter(
        (ticket) =>
          !loaded.has(ticket.id) &&
          (roots.has(ticket.id) || (ticket.duplicateOfTicketId !== null && ticket.duplicateOfTicketId !== undefined && roots.has(ticket.duplicateOfTicketId)))
      );

  const on = invoiceDate ?? new Date();
  const agreedRates: AgreedRate[] = supplierId
    ? records.rates
        .filter(
          (rate) =>
            rate.supplierId === supplierId &&
            rate.effectiveFrom.getTime() <= on.getTime() &&
            (rate.effectiveTo === null || rate.effectiveTo.getTime() >= on.getTime())
        )
        .map((rate) => ({
          productName: rate.productName,
          rate: rate.rate,
          unit: rate.unit,
          spruceItemCode: rate.spruceItemCode ?? null,
          supplierItemCode: rate.supplierItemCode ?? null,
        }))
    : [];

  const competingLines: CompetingLine[] = po
    ? records.openInvoiceLines
        .filter((other) => (!supplierId || other.supplierId === supplierId) && onSamePo(other.poNumber, po))
        .map((other) => ({
          invoiceLineId: other.invoiceLineId,
          invoiceNumber: other.invoiceNumber,
          lineNumber: other.lineNumber,
          invoiceDate: other.invoiceDate,
        }))
    : [];

  return {
    orders,
    aliases: supplierId ? records.aliases.filter((alias) => alias.supplierId === supplierId) : [],
    tickets: [...onPo, ...twins],
    agreedRates,
    competingLines,
    tolerances: records.tolerances,
  };
}

export interface DryRunLineDecision {
  decision: MatchDecision;
  /** The flag production would write on the line. */
  flag: LineItemFlag;
  /** Billed quantity at the agreed rate, as production computes it; null without a rate. */
  approvedTotal: number | null;
  /** How many rows each kind of input offered the engine, for reading the verdict. */
  considered: { orders: number; tickets: number; rates: number; competingLines: number; loads: number };
  /** The dispatch loads a trucking line's verdict counts; empty for a material line. */
  loadIds: string[];
}

/**
 * The verdict and flag production would store for this line, stored nowhere.
 *
 * Same engine call and same flag rule as matchInvoiceLineById and its
 * applyLineItemColumns; only the persist step is missing.
 */
export function decideInvoiceLineDryRun(
  line: StoredLine,
  context: { lineId: string; supplierId: string | null; invoiceDate: Date | null },
  records: RelatedRecords
): DryRunLineDecision {
  const inputs = selectLineInputs(line, context.supplierId, context.invoiceDate, records);
  const decision = matchInvoiceLine(
    {
      id: context.lineId,
      poNumber: line.poNumber,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      unitRate: line.unitRate,
      supplierId: context.supplierId,
      invoiceDate: context.invoiceDate,
    },
    inputs
  );

  const totals = decision.totals;
  const agreedRate = totals?.agreedRate ?? null;
  const flag = deriveLineItemFlag({
    hasOrder: decision.orderId !== null,
    ticketCount: decision.ticketIds.length,
    hasQuantityDiscrepancy: (totals?.quantityDiscrepancy ?? null) !== null,
    hasRateDiscrepancy: (totals?.rateDiscrepancy ?? null) !== null,
    hasAgreedRate: agreedRate !== null,
    rateUnitMismatch: totals?.rateUnitMismatch ?? false,
  });

  return {
    decision,
    flag,
    approvedTotal: agreedRate === null ? null : Number((line.quantity * agreedRate).toFixed(4)),
    considered: {
      orders: inputs.orders.length,
      tickets: inputs.tickets.length,
      rates: inputs.agreedRates.length,
      competingLines: inputs.competingLines.length,
      loads: 0,
    },
    loadIds: [],
  };
}

/**
 * The verdict and flag production would store for a trucking company's line,
 * stored nowhere: checked against the dispatch loads it bills and the rate
 * dispatch set on them (client, Q14), as matchHaulLineById does.
 *
 * Mirrors its loaders: the carrier's loads in the window around the line's
 * haul date (or the invoice date), and other unsettled lines whose verdicts
 * count any of those loads. The flag counts the load as the line's order and
 * ticket, as applyLineItemColumns does for a haul.
 */
export function decideHaulLineDryRun(
  line: StoredLine,
  context: { lineId: string; supplierId: string | null; invoiceDate: Date | null },
  records: RelatedRecords
): DryRunLineDecision {
  const tolerances = records.haulTolerances;
  const loads = records.loads.filter((load) => load.carrierSupplierId === context.supplierId);
  const candidateIds = new Set(loads.map((load) => load.id));
  const competingLines: CompetingHaulLine[] = records.openInvoiceLines
    .filter((other) => other.invoiceLineId !== context.lineId && other.loadIds.some((id) => candidateIds.has(id)))
    .map((other) => ({
      invoiceLineId: other.invoiceLineId,
      invoiceNumber: other.invoiceNumber,
      lineNumber: other.lineNumber,
      loadIds: other.loadIds,
    }));

  const decision = matchHaulLine(
    {
      id: context.lineId,
      poNumber: line.poNumber,
      ticketNumber: line.ticketNumber,
      serviceDate: line.serviceDate,
      quantity: line.quantity,
      unit: line.unit,
      unitRate: line.unitRate,
      supplierId: context.supplierId,
      invoiceDate: context.invoiceDate,
    },
    loads,
    { tolerances, competingLines }
  );

  const totals = decision.totals;
  const agreedRate = totals?.agreedRate ?? null;
  const counted = decision.loadIds.length;
  return {
    decision,
    flag: deriveLineItemFlag({
      hasOrder: counted > 0,
      ticketCount: counted,
      hasQuantityDiscrepancy: (totals?.quantityDiscrepancy ?? null) !== null,
      hasRateDiscrepancy: (totals?.rateDiscrepancy ?? null) !== null,
      hasAgreedRate: agreedRate !== null,
      rateUnitMismatch: totals?.rateUnitMismatch ?? false,
    }),
    approvedTotal: agreedRate === null ? null : Number((line.quantity * agreedRate).toFixed(4)),
    considered: { orders: 0, tickets: 0, rates: 0, competingLines: competingLines.length, loads: loads.length },
    loadIds: decision.loadIds,
  };
}

// ---------------------------------------------------------------------------
// The invoice total, and tickets that arrived inside the invoice's PDF.
// ---------------------------------------------------------------------------

export type InvoiceTotalCheck =
  | { result: 'no-lines'; note: null }
  | { result: 'unpriced'; note: string; unpricedLines: number }
  | { result: 'ok' | 'mismatch'; note: string | null; expectedWithHst: number; billed: number };

/**
 * The note production would put on the invoice about its total.
 *
 * Mirrors refreshInvoiceTotalCheck: with any line lacking an agreed rate the
 * total is not checked; otherwise the lines at their agreed rates plus 13%
 * HST must come within five cents of the billed total.
 */
export function previewInvoiceTotalCheck(
  lines: ReadonlyArray<{ description: string; quantity: number; agreedRate: number | null }>,
  billedTotal: number
): InvoiceTotalCheck {
  if (lines.length === 0) return { result: 'no-lines', note: null };
  const unpriced = lines.filter((line) => line.agreedRate === null);
  if (unpriced.length > 0) {
    return {
      result: 'unpriced',
      unpricedLines: unpriced.length,
      note:
        `Total not checked: ${unpriced.length} of ${lines.length} line(s) have no applicable agreed rate ` +
        `(${unpriced.map((line) => line.description).join('; ')}). Billed: $${billedTotal.toFixed(2)}. ` +
        'It is checked again automatically once those rates are added.',
    };
  }
  const subtotal = lines.reduce((sum, line) => sum + line.quantity * (line.agreedRate as number), 0);
  const withHst = subtotal * 1.13;
  const mismatch = Math.abs(withHst - billedTotal) > 0.05;
  return {
    result: mismatch ? 'mismatch' : 'ok',
    expectedWithHst: Number(withHst.toFixed(2)),
    billed: billedTotal,
    note: mismatch
      ? `Total amount mismatch. Expected pay: $${withHst.toFixed(2)} (Subtotal: $${subtotal.toFixed(2)} + 13% HST). Billed: $${billedTotal.toFixed(2)}.`
      : null,
  };
}

/** A delivery ticket read from a page of the sample itself (the supplier's own copy). */
export interface EmailedTicketReading {
  page: number;
  ticketNumber: string | null;
  poNumber: string | null;
  quantity: number | null;
  unit: string | null;
  material: string | null;
  ticketDate: Date | null;
}

/** Letters and digits only, at least three: the copy key of tickets/ticketCopies.ts. */
function copyKey(ticketNumber: string | null): string | null {
  const key = (ticketNumber ?? '').replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
  return key.length >= 3 ? key : null;
}

/**
 * The records with the sample's own ticket pages added as emailed copies, as
 * production files them (A15): each page becomes an EMAIL ticket under the
 * invoice's supplier, and one carrying the number of a ticket already on file
 * from that supplier (or with no supplier, on the same PO) is that load's
 * second copy rather than a load of its own. Mirrors the rule in
 * tickets/ticketCopies.ts for the simple case of one copy on file; that
 * module is not imported because it pulls in the ticket service and, with
 * it, file storage, which nothing in a dry run may reach.
 */
export function withEmailedTickets(
  records: RelatedRecords,
  readings: readonly EmailedTicketReading[],
  supplierId: string | null,
  idPrefix: string
): RelatedRecords {
  if (readings.length === 0) return records;
  const added: RelatedTicket[] = readings.map((reading) => {
    const key = copyKey(reading.ticketNumber);
    const original = key
      ? records.tickets.find(
          (ticket) =>
            !ticket.duplicateOfTicketId &&
            copyKey(ticket.ticketNumber) === key &&
            (ticket.supplierId && supplierId ? ticket.supplierId === supplierId : onSamePo(ticket.poNumber, reading.poNumber))
        )
      : undefined;
    return {
      id: `${idPrefix}-p${reading.page}`,
      ticketNumber: reading.ticketNumber,
      poNumber: reading.poNumber,
      quantity: reading.quantity,
      unit: reading.unit,
      material: reading.material,
      supplierId,
      ticketDate: reading.ticketDate,
      source: TicketSource.EMAIL,
      emailedBySupplier: true,
      // The copy on file arrived first, so it is the one that counts whichever
      // kind it is (primaryCopy: a driver's copy first, then the earliest).
      duplicateOfTicketId: original?.id ?? null,
      claim: null,
    };
  });
  return { ...records, tickets: [...records.tickets, ...added] };
}
