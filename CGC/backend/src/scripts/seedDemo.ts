import { pathToFileURL } from 'node:url';

import bcrypt from 'bcryptjs';
import {
  DriverType,
  EmailIngestionStatus,
  Prisma,
  SenderType,
  SenderTypeResolved,
  SupplierType,
  UserRole,
  type DeliveryStatus,
} from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { businessDayOf, startOfBusinessDay } from '../lib/businessDay.js';
import { representativeLineId } from '../modules/dispatch/dispatchOrderView.js';
import { DispatchLoadsService, loadsFollowStopDriver } from '../modules/dispatch/dispatchLoads.service.js';
import { matchInvoiceById, matchTicketById } from '../modules/matching/matching.service.js';
import { parseEditRequest } from '../modules/orders/edits/editableFields.js';
import { applyOrderEdits } from '../modules/orders/edits/orderEdits.service.js';
import { runImportBatch, type BatchFile } from '../modules/orders/import/importBatch.service.js';
import type { ParsedSpruceReport, ParsedSpruceRow, SpruceReportType } from '../modules/orders/spruce/spruceReportTypes.js';
import { ATTACHMENT_REASONS } from '../services/emailAttachments.js';

/**
 * A fake but realistic local dataset for clicking through the app, and for the
 * browser tests: every behaviour the client's answers of Oct 2026 changed has
 * an order, a stop, an invoice or an email here to look at.
 *
 * Usage (from CGC/backend, against a loopback database only):
 *
 *   DATABASE_URL=postgresql://cgctest:cgctest@127.0.0.1:55432/cgc_demo \
 *   DIRECT_URL=postgresql://cgctest:cgctest@127.0.0.1:55432/cgc_demo \
 *   npm run seed:demo
 *
 * docs/local-demo.md has the whole walk-through: the database, the backend's
 * local environment, the logins and what to look at for each answer.
 *
 * It wipes every table of the app first, so it is re-runnable and always
 * starts from the same state. That is also why it refuses anything but a
 * loopback database, and refuses outright when NODE_ENV is production.
 *
 * Everything is invented: names, addresses, phone numbers (555), suppliers,
 * order numbers (9999-99xxxx) and POs (9999-88xxxx). Dates are relative to
 * today's business day in America/Toronto, so the dispatch board always has
 * work on it.
 *
 * Where the app has a service for something, the seed goes through it so the
 * data is what the app itself would have written: the Spruce reports through
 * the morning import (runImportBatch, from already-read rows rather than
 * PDFs), the office's choices through the order editor, loads through the
 * loads service, and verdicts through the matching engine. Only modules that
 * load without the server's configuration are imported, so the seed needs
 * DATABASE_URL and nothing else and never loads env.ts. (Prisma itself fills
 * an unset variable from CGC/backend/.env when that file exists. The guard
 * reads the environment, whose values win over that file's, and refuses an
 * unset DATABASE_URL, so it judges the database Prisma really uses.) Assigning a stop
 * is written here directly for that reason (dispatch.service pulls in the
 * mailer and its configuration); it writes what assignOrder writes.
 *
 * Files are not created. Invoices and tickets point at /uploads/demo/...
 * paths that do not exist, so their previews show as missing locally.
 */

/**
 * The one password every demo login shares. Local only, and listed in
 * docs/local-demo.md: it protects nothing and must never be a real password.
 */
export const DEMO_PASSWORD = 'demo-local-only';

/** Hosts a demo database may be on. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Refuses to seed anything but a loopback database, and anything at all when
 * NODE_ENV is production. Pure, so the refusals can be tested.
 *
 * Both connection strings are checked: Prisma's client reads DATABASE_URL and
 * migrations read DIRECT_URL, and a remote one of either would be written to.
 * A `host` query parameter (which libpq and Prisma honour) is checked too, so
 * `localhost/db?host=elsewhere` is not mistaken for a local database.
 */
export function assertDemoDatabase(env: Record<string, string | undefined> = process.env): void {
  // Normalised, so 'Production' or a stray space is refused as well.
  if (env.NODE_ENV?.trim().toLowerCase() === 'production') {
    throw new Error('Refusing to seed demo data with NODE_ENV=production.');
  }
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required, and must point at a loopback database.');

  for (const name of ['DATABASE_URL', 'DIRECT_URL'] as const) {
    const raw = env[name];
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`${name} is not a valid database URL.`);
    }
    if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
      throw new Error(`${name} must be a postgresql:// URL.`);
    }
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error(`Refusing to seed a non-loopback database (${name} host: ${url.hostname || 'none'}).`);
    }
    for (const host of url.searchParams.getAll('host')) {
      if (!LOOPBACK_HOSTS.has(host)) {
        throw new Error(`Refusing to seed a non-loopback database (${name} host parameter: ${host}).`);
      }
    }
  }
}

/** Every table of the app, from the schema, so a new model is wiped too. */
function appTables(): string[] {
  return Prisma.dmmf.datamodel.models.map(model => model.dbName ?? model.name);
}

/**
 * Empties every table of the app in one statement. CASCADE takes care of the
 * foreign keys; Prisma's own migration table is not one of the models, so the
 * schema stays migrated.
 */
export async function wipeAppTables(): Promise<void> {
  assertDemoDatabase();
  const list = appTables().map(table => `"${table}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

// ------------------------------------------------------------------ days

const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' plus `days` calendar days. */
function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** A day as Spruce prints it: month first, "11/3/2026". */
function spruceDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return `${month}/${date}/${year}`;
}

/** An instant on a business day, by Toronto clock time. */
function at(day: string, hours: number, minutes = 0): Date {
  return new Date(startOfBusinessDay(day)!.getTime() + (hours * 60 + minutes) * 60_000);
}

/** A stored calendar date (`@db.Date`). */
const dateOnly = (day: string) => new Date(`${day}T00:00:00.000Z`);

// ------------------------------------------------------------------ people and suppliers

export const DEMO_USERS = {
  owner: { email: 'owner@demo.invalid', name: 'Olive Owner (demo)', role: UserRole.OWNER },
  admin: { email: 'admin@demo.invalid', name: 'Adam Admin (demo)', role: UserRole.ADMIN },
  ap: { email: 'ap@demo.invalid', name: 'Avery Payables (demo)', role: UserRole.AP_USER },
  driver1: { email: 'driver1@demo.invalid', name: 'Dana Driver (demo)', role: UserRole.DRIVER },
  driver2: { email: 'driver2@demo.invalid', name: 'Drew Driver (demo)', role: UserRole.DRIVER },
} as const;

/** Spruce vendor codes, as Item Tracking prints them. */
const VENDOR = {
  examplestone: 'EXAMPLESTN01',
  pavers: 'DEMOPAVE01',
  aggregates: 'DEMOAGG01',
} as const;

// ------------------------------------------------------------------ the Spruce reports

interface DemoLine {
  item: string;
  product: string;
  qty: number;
  unit: string;
  /** Selling price; the Order report prints it. Comment lines are free. */
  price: number;
  po?: string;
  vendor?: string;
  vendorLocation?: string;
}

interface DemoOrder {
  doc: string;
  customer: string;
  /** Printed only on the Deliveries report; null means the report left it blank. */
  phone: string | null;
  address: string;
  instructions?: string;
  entered: string;
  /** Null: Spruce has no delivery date for it. */
  deliveryDate: string | null;
  /** The Order report's SCH column: a scheduled CGC delivery. */
  scheduled: boolean;
  reports: SpruceReportType[];
  lines: DemoLine[];
}

const comment = (text: string): DemoLine => ({ item: 'COMMENT', product: text, qty: 1, unit: 'EA', price: 0 });
const charge = (item: string, product: string, price: number): DemoLine => ({ item, product, qty: 1, unit: 'EA', price });

const money = (value: number) => Math.round(value * 100) / 100;

/** The rows each report prints for these orders. */
function reportRows(orders: DemoOrder[], type: SpruceReportType): ParsedSpruceRow[] {
  const rows: ParsedSpruceRow[] = [];
  for (const order of orders.filter(o => o.reports.includes(type))) {
    const subtotal = money(order.lines.reduce((sum, line) => sum + line.qty * line.price, 0));
    const total = money(subtotal * 1.13);
    for (const line of order.lines) {
      const base: ParsedSpruceRow = {
        documentNumber: order.doc,
        customerName: order.customer,
        product: line.product,
        itemNumber: line.item,
        quantity: line.qty,
        unit: line.unit,
        source: { page: 1, row: rows.length + 1 },
      };
      if (type === 'ITEM_TRACKING') {
        rows.push({
          ...base,
          orderDateRaw: spruceDay(order.entered),
          ...(order.deliveryDate ? { deliveryDateRaw: spruceDay(order.deliveryDate) } : {}),
          shippingAddress: order.address,
          ...(order.instructions ? { deliveryInstructions: order.instructions } : {}),
          ...(line.po ? { poNumber: line.po } : {}),
          ...(line.vendor ? { vendorName: line.vendor } : {}),
          ...(line.vendorLocation ? { vendorLocation: line.vendorLocation } : {}),
        });
      } else if (type === 'ORDER_SUMMARY') {
        rows.push({
          ...base,
          orderDateRaw: spruceDay(order.entered),
          accountCode: 'CASH',
          cashier: 'DEMO',
          spruceStatus: 'Open',
          ...(order.scheduled ? { deliveryFlag: 'SCH' } : {}),
          unitPrice: line.price,
          totalWithTax: total,
          remaining: subtotal,
        });
      } else {
        rows.push({
          ...base,
          ...(order.deliveryDate ? { deliveryDateRaw: spruceDay(order.deliveryDate) } : {}),
          accountName: 'Cash Sales',
          ...(order.phone ? { phone: order.phone } : {}),
          route: 'CAMB',
          spruceStatus: 'Sched',
          totalWithTax: total,
        });
      }
    }
  }
  return rows;
}

/** One morning's three reports, as the import screen would hand them over. */
function morningUpload(orders: DemoOrder[], day: string): BatchFile[] {
  const ranges: Record<SpruceReportType, { fromRaw: string; toRaw: string }> = {
    DELIVERY: { fromRaw: spruceDay(day), toRaw: spruceDay(day) },
    ORDER_SUMMARY: { fromRaw: spruceDay(addDays(day, -14)), toRaw: spruceDay(day) },
    ITEM_TRACKING: { fromRaw: spruceDay(addDays(day, -30)), toRaw: spruceDay(day) },
  };
  const names: Record<SpruceReportType, string> = {
    DELIVERY: 'Deliveries',
    ORDER_SUMMARY: 'Order Summary',
    ITEM_TRACKING: 'Item Tracking',
  };
  return (['ITEM_TRACKING', 'ORDER_SUMMARY', 'DELIVERY'] as SpruceReportType[]).map(reportType => {
    const report: ParsedSpruceReport = {
      type: reportType,
      rows: reportRows(orders, reportType),
      unreadable: [],
      pageCount: 1,
      readBy: 'PARSER',
      dateRange: ranges[reportType],
    };
    return {
      reportType,
      fileName: `demo-${names[reportType].replace(/\s+/g, '-').toLowerCase()}-${day}.pdf`,
      // Stands in for the PDF's bytes: only its hash is kept.
      buffer: Buffer.from(`demo-${reportType}-${day}`),
      report,
    };
  });
}

/** The demo's order numbers: Spruce's shape, obviously not Spruce's numbers. */
export const DEMO_DOCS = {
  fobCollects: '9999-990001',
  fobHauled: '9999-990002',
  directDeliveryWording: '9999-990003',
  quote: '9999-990004',
  pitChosen: '9999-990005',
  pitUnnamed: '9999-990006',
  chargeOnlySlinger: '9999-990007',
  chargeOnlyTriaxle: '9999-990008',
  poDelivery: '9999-990010',
  tripFirst: '9999-990011',
  tripSecond: '9999-990012',
  carrierNoRate: '9999-990013',
  yardRun: '9999-990020',
  yardDoneToday: '9999-990021',
  yardPoolA: '9999-990022',
  yardPoolB: '9999-990023',
  reimported: '9999-990030',
  noPhoneDelivery: '9999-990040',
  noPhonePickup: '9999-990041',
  carriedOver: '9999-990050',
  pastPavers: '9999-990051',
  pastGravel: '9999-990052',
  pastTripSand: '9999-990053',
  pastTripGravel: '9999-990054',
  tomorrow: '9999-990060',
} as const;

const D = DEMO_DOCS;

/** Demo POs: one per order that buys from a supplier. */
const po = (doc: string) => `9999-88${doc.slice(-4)}`;

function examplestoneLine(doc: string, product: string, qty: number, unit: string, price: number): DemoLine {
  return { item: 'EXSTONE', product, qty, unit, price, po: po(doc), vendor: VENDOR.examplestone, vendorLocation: 'Ayr' };
}

function paversLines(doc: string): DemoLine[] {
  return [
    { item: 'DPCHAR60', product: 'Demo Paver Charcoal 60mm', qty: 300, unit: 'SQFT', price: 6.25, po: po(doc), vendor: VENDOR.pavers, vendorLocation: 'Cambridge' },
    { item: 'DPSAND', product: 'Polymeric Sand Grey', qty: 6, unit: 'EA', price: 42, po: po(doc), vendor: VENDOR.pavers, vendorLocation: 'Cambridge' },
    charge('MISCDELD', 'Flatbed delivery', 95),
    { item: 'RSKID', product: 'Refundable skid deposit', qty: 3, unit: 'EA', price: 25 },
  ];
}

function aggregateLine(doc: string, item: string, product: string, qty: number, price: number): DemoLine {
  return { item, product, qty, unit: 'MT', price, po: po(doc), vendor: VENDOR.aggregates, vendorLocation: 'Puslinch' };
}

const soil = (qty: number): DemoLine => ({ item: 'SOILGRDNA', product: 'Garden Soil Bulk', qty, unit: 'CY', price: 48 });
const mulch = (qty: number): DemoLine => ({ item: 'MULCHBLK', product: 'Mulch Black Dyed', qty, unit: 'CY', price: 52 });
const delivery = () => charge('MISCDEL', 'Delivery charge', 75);

/** Yesterday's upload: what went out yesterday, and one order for today entered early. */
function yesterdaysOrders(today: string): DemoOrder[] {
  const yesterday = addDays(today, -1);
  const all: SpruceReportType[] = ['DELIVERY', 'ORDER_SUMMARY', 'ITEM_TRACKING'];
  return [
    {
      // Re-imported today with a changed quantity and instruction (A7).
      doc: D.reimported, customer: 'Riley Example', phone: '519-555-0130', address: '30 Sample Crescent, Cambridge',
      instructions: 'Leave at the side gate', entered: addDays(today, -2), deliveryDate: today, scheduled: true,
      reports: ['ORDER_SUMMARY', 'ITEM_TRACKING'], lines: [soil(10), delivery()],
    },
    {
      // Due yesterday and never sent: today's Carried over.
      doc: D.carriedOver, customer: 'Casey Placeholder', phone: '519-555-0150', address: '50 Example Line, Ayr',
      entered: addDays(today, -5), deliveryDate: yesterday, scheduled: true, reports: all, lines: [mulch(5), delivery()],
    },
    {
      doc: D.pastPavers, customer: 'Jordan Sample', phone: '519-555-0151', address: '51 Demo Court, Kitchener',
      entered: addDays(today, -3), deliveryDate: yesterday, scheduled: true, reports: all, lines: paversLines(D.pastPavers),
    },
    {
      doc: D.pastGravel, customer: 'Morgan Example', phone: '519-555-0152', address: '52 Fictional Rd, Guelph',
      entered: addDays(today, -3), deliveryDate: yesterday, scheduled: true, reports: all,
      lines: [aggregateLine(D.pastGravel, 'AGG19', 'A Gravel 19mm', 22, 32), delivery()],
    },
    {
      doc: D.pastTripSand, customer: 'Taylor Testcase', phone: '519-555-0153', address: '53 Sample Sideroad, Puslinch',
      entered: addDays(today, -4), deliveryDate: yesterday, scheduled: true, reports: all,
      lines: [aggregateLine(D.pastTripSand, 'SANDSCR', 'Screened Sand', 15, 30), charge('MISCDELT', 'Tri-axle dump charge', 140)],
    },
    {
      doc: D.pastTripGravel, customer: 'Quinn Demo', phone: '519-555-0154', address: '54 Demo Ave, Cambridge',
      entered: addDays(today, -4), deliveryDate: yesterday, scheduled: true, reports: all,
      lines: [aggregateLine(D.pastTripGravel, 'AGG19', 'A Gravel 19mm', 20, 32), charge('MISCDELT', 'Tri-axle dump charge', 140)],
    },
  ];
}

/** This morning's upload. */
function todaysOrders(today: string): DemoOrder[] {
  const all: SpruceReportType[] = ['DELIVERY', 'ORDER_SUMMARY', 'ITEM_TRACKING'];
  const noDeliveries: SpruceReportType[] = ['ORDER_SUMMARY', 'ITEM_TRACKING'];
  const entered = addDays(today, -3);
  return [
    {
      // A1: "FOB <supplier> <yard>": the customer collects there. Dated today,
      // and still off the board.
      doc: D.fobCollects, customer: 'Pat Example', phone: null, address: '1 Example St, Cambridge',
      entered, deliveryDate: today, scheduled: false, reports: noDeliveries,
      lines: [comment('FOB EXAMPLESTONE AYR'), examplestoneLine(D.fobCollects, 'Examplestone Patio Slab 24x24 Grey', 40, 'EA', 18)],
    },
    {
      // A1, the other 5%: the office sets "Delivery via supplier" on it.
      doc: D.fobHauled, customer: 'Sam Sample', phone: null, address: '2 Sample Rd, Cambridge',
      entered, deliveryDate: today, scheduled: false, reports: noDeliveries,
      lines: [comment('FOB EXAMPLESTONE AYR'), examplestoneLine(D.fobHauled, 'Examplestone Retaining Wall Block', 30, 'EA', 22)],
    },
    {
      // A2: supplier delivery wording no longer hides an order; staff confirm.
      doc: D.directDeliveryWording, customer: 'Alex Fictional', phone: '519-555-0103', address: '3 Fictional Way, Kitchener',
      entered, deliveryDate: today, scheduled: true, reports: all,
      lines: [
        examplestoneLine(D.directDeliveryWording, 'Examplestone Paver Holland Red', 200, 'SQFT', 5.5),
        charge('MISCDEL', 'Examplestone Direct Delivery', 120),
      ],
    },
    {
      // A3: a quotation. Item Tracking dates it today; it is still not work.
      doc: D.quote, customer: 'Quinn Quotation', phone: null, address: '4 Estimate Lane, Cambridge',
      entered: today, deliveryDate: today, scheduled: false, reports: ['ITEM_TRACKING'],
      lines: [soil(6), delivery()],
    },
    {
      // A5: PitBlk, and dispatch chose the pit (set below through the order editor).
      doc: D.pitChosen, customer: 'Jamie Demo', phone: '519-555-0105', address: '5 Demo Drive, Cambridge',
      entered, deliveryDate: today, scheduled: true, reports: all,
      lines: [{ item: 'PITTOPSOIL', product: 'PitBlk Screened Topsoil', qty: 10, unit: 'CY', price: 38 }, delivery()],
    },
    {
      // A5: PitBlk with no pit named yet: the board asks.
      doc: D.pitUnnamed, customer: 'Robin Sample', phone: '519-555-0106', address: '6 Sample Street, Ayr',
      entered, deliveryDate: today, scheduled: true, reports: all,
      lines: [{ item: 'PITGRAVEL', product: 'PitBlk A Gravel 19mm', qty: 18, unit: 'MT', price: 31 }, delivery()],
    },
    {
      // A6: a CGC charge, no date, on no Deliveries report: likely delivered already.
      doc: D.chargeOnlySlinger, customer: 'Charlie Example', phone: null, address: '7 Example Blvd, Cambridge',
      entered: addDays(today, -9), deliveryDate: null, scheduled: false, reports: noDeliveries,
      lines: [mulch(8), charge('MISCDELS', 'Slinger truck charge', 160)],
    },
    {
      doc: D.chargeOnlyTriaxle, customer: 'Frankie Sample', phone: null, address: '8 Sample Grove, Kitchener',
      entered: addDays(today, -8), deliveryDate: null, scheduled: false, reports: noDeliveries,
      lines: [soil(12), charge('MISCDELT', 'Tri-axle dump charge', 140)],
    },
    {
      // A4: a supplier PO means the CGC driver collects at that supplier.
      doc: D.poDelivery, customer: 'Jessie Fictional', phone: '519-555-0110', address: '10 Fictional Court, Cambridge',
      entered, deliveryDate: today, scheduled: true, reports: all, lines: paversLines(D.poDelivery),
    },
    {
      // A4/A14: a brokered truck takes two POs on one trip.
      doc: D.tripFirst, customer: 'Kai Example', phone: '519-555-0111', address: '11 Example Concession, Puslinch',
      entered, deliveryDate: today, scheduled: true, reports: all,
      lines: [aggregateLine(D.tripFirst, 'AGG19', 'A Gravel 19mm', 20, 32), charge('MISCDELT', 'Tri-axle dump charge', 140)],
    },
    {
      doc: D.tripSecond, customer: 'Lee Sample', phone: '519-555-0112', address: '12 Sample Townline, Puslinch',
      entered, deliveryDate: today, scheduled: true, reports: all,
      lines: [aggregateLine(D.tripSecond, 'SANDSCR', 'Screened Sand', 16, 30), charge('MISCDELT', 'Tri-axle dump charge', 140)],
    },
    {
      // A14: a carrier is on the load but nobody has set its rate yet.
      doc: D.carrierNoRate, customer: 'Max Demo', phone: '519-555-0113', address: '13 Demo Road, Guelph',
      entered, deliveryDate: today, scheduled: true, reports: all,
      lines: [aggregateLine(D.carrierNoRate, 'AGG19', 'A Gravel 19mm', 21, 32), charge('MISCDELT', 'Tri-axle dump charge', 140)],
    },
    {
      doc: D.yardRun, customer: 'Nico Example', phone: '519-555-0120', address: '20 Example Park, Cambridge',
      entered, deliveryDate: today, scheduled: true, reports: all, lines: [soil(4), delivery()],
    },
    {
      doc: D.yardDoneToday, customer: 'Ollie Sample', phone: '519-555-0121', address: '21 Sample Hill, Cambridge',
      entered, deliveryDate: today, scheduled: true, reports: all, lines: [mulch(3), delivery()],
    },
    {
      doc: D.yardPoolA, customer: 'Parker Fictional', phone: '519-555-0122', address: '22 Fictional Meadow, Kitchener',
      entered, deliveryDate: today, scheduled: true, reports: all, lines: [soil(6), delivery()],
      instructions: 'Small truck only, low wires',
    },
    {
      doc: D.yardPoolB, customer: 'Reese Demo', phone: '519-555-0123', address: '23 Demo Trail, Ayr',
      entered, deliveryDate: today, scheduled: true, reports: all, lines: [mulch(4), delivery()],
    },
    {
      // A7: yesterday's upload had it too; today's changes the quantity and
      // the instruction. One set of lines, marked Updated.
      doc: D.reimported, customer: 'Riley Example', phone: '519-555-0130', address: '30 Sample Crescent, Cambridge',
      instructions: 'Call before, leave at the side gate', entered: addDays(today, -2), deliveryDate: today, scheduled: true,
      reports: all, lines: [soil(12), delivery()],
    },
    {
      // A8: on the Deliveries report with the phone left blank.
      doc: D.noPhoneDelivery, customer: 'Sky Example', phone: null, address: '40 Example Heights, Cambridge',
      entered, deliveryDate: today, scheduled: true, reports: all, lines: [mulch(2), delivery()],
    },
    {
      // A8: a yard pickup with no phone. Never on a Deliveries report, never flagged.
      doc: D.noPhonePickup, customer: 'Toni Sample', phone: null, address: 'PICKUP',
      entered, deliveryDate: null, scheduled: false, reports: noDeliveries, lines: [soil(1)],
    },
    {
      doc: D.tomorrow, customer: 'Val Fictional', phone: null, address: '60 Fictional Bend, Cambridge',
      entered, deliveryDate: addDays(today, 1), scheduled: true, reports: noDeliveries, lines: [soil(8), delivery()],
    },
  ];
}

// ------------------------------------------------------------------ stops

interface StopOptions {
  priority: number;
  status: DeliveryStatus;
  placedAt: Date;
  completedAt?: Date;
  photo?: string;
}

/**
 * Gives a whole order to a driver: what DispatchService.assignOrder writes
 * (the stop on the order's first product, its history, the driver on every
 * line, the loads following a brokered driver), plus, for a finished stop,
 * what the driver's phone writes on the way.
 */
async function giveStop(documentId: string, driver: { id: string; type: DriverType }, options: StopOptions) {
  const document = await prisma.orderDocument.findUniqueOrThrow({
    where: { id: documentId },
    select: { lines: { select: { id: true, product: true, spruceItemNumber: true, lineClass: true }, orderBy: [{ lineNumber: 'asc' }, { id: 'asc' }] } },
  });
  const orderId = representativeLineId(document as Parameters<typeof representativeLineId>[0]);
  if (!orderId) throw new Error(`Demo order ${documentId} has no lines.`);

  const done = options.status === 'DELIVERED';
  const stop = await prisma.delivery.create({
    data: {
      documentId,
      orderId,
      driverId: driver.id,
      status: options.status,
      priority: options.priority,
      createdAt: options.placedAt,
      // Out of the yard 45 minutes before it was done, but never before it was placed.
      ...(done
        ? {
            startedAt: new Date(Math.max(options.placedAt.getTime(), options.completedAt!.getTime() - 45 * 60_000)),
            completedAt: options.completedAt!,
          }
        : {}),
      ...(options.photo ? { deliveryPhotoUrl: options.photo } : {}),
    },
  });
  await prisma.deliveryHistory.create({
    data: { deliveryId: stop.id, status: 'PLACED', notes: 'Order assigned to driver', createdAt: options.placedAt },
  });
  if (done) {
    await prisma.deliveryHistory.createMany({
      data: [
        { deliveryId: stop.id, status: 'OUT_FOR_DELIVERY', createdAt: stop.startedAt! },
        { deliveryId: stop.id, status: 'DELIVERED', createdAt: options.completedAt! },
      ],
    });
  }
  await prisma.order.updateMany({
    where: { documentId },
    data: { driverId: driver.id, deliveryStatus: done ? 'COMPLETED' : 'NOT_STARTED' },
  });
  await loadsFollowStopDriver(prisma, documentId, null, driver);
  return stop;
}

// ------------------------------------------------------------------ the seed

export interface DemoSeedSummary {
  today: string;
  users: number;
  drivers: number;
  documents: number;
  stops: number;
  loads: number;
  tickets: number;
  invoices: number;
  emailEvents: number;
}

export async function seedDemo(): Promise<DemoSeedSummary> {
  assertDemoDatabase();
  const today = businessDayOf();
  const yesterday = addDays(today, -1);
  const now = new Date();

  // Re-runnable: always the same starting point, never accumulated duplicates.
  await wipeAppTables();

  // ---- people
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const users = Object.fromEntries(
    await Promise.all(
      Object.entries(DEMO_USERS).map(async ([key, user]) => [key, await prisma.user.create({ data: { ...user, passwordHash } })])
    )
  ) as Record<keyof typeof DEMO_USERS, { id: string }>;
  const owner = users.owner.id;

  const dana = await prisma.driver.create({
    data: {
      name: DEMO_USERS.driver1.name, phone: '519-555-0001', email: DEMO_USERS.driver1.email,
      type: DriverType.CGC_FLEET, userId: users.driver1.id,
    },
  });
  const drew = await prisma.driver.create({
    data: {
      name: DEMO_USERS.driver2.name, phone: '519-555-0002', email: DEMO_USERS.driver2.email,
      type: DriverType.CGC_FLEET, userId: users.driver2.id,
    },
  });
  // A4: the truck the client brokers. No login: a brokered driver does not
  // use the app, dispatch records the loads for them.
  const casey = await prisma.driver.create({
    data: {
      name: 'Casey Broker (demo)', phone: '519-555-0003', type: DriverType.INDEPENDENT,
      companyName: 'Demo Haulage Ltd.',
    },
  });

  // ---- suppliers
  const examplestone = await prisma.supplier.create({
    data: {
      name: 'Examplestone Ltd.', type: SupplierType.SUPPLIER, address: '12 Demo Quarry Rd, Ayr ON',
      emailDomains: ['examplestone.example'], emailAddresses: [], keywords: ['examplestone'],
      spruceVendors: { create: { code: VENDOR.examplestone } },
    },
  });
  const pavers = await prisma.supplier.create({
    data: {
      name: 'Demo Pavers Inc.', type: SupplierType.SUPPLIER, address: '55 Sample Paver Way, Cambridge ON',
      emailDomains: [], emailAddresses: ['billing@demopavers.example'], keywords: ['demo pavers'],
      contactName: 'Pavers Billing (demo)', contactEmail: 'billing@demopavers.example',
      spruceVendors: { create: { code: VENDOR.pavers } },
    },
  });
  const aggregates = await prisma.supplier.create({
    data: {
      name: 'Demo Aggregates Ltd.', type: SupplierType.SUPPLIER, address: '7 Sample Pit Rd, Puslinch ON',
      emailDomains: ['demoaggregates.example'], emailAddresses: [], keywords: ['demo aggregates'],
      spruceVendors: { create: { code: VENDOR.aggregates } },
    },
  });
  // A5: the pit dispatch chooses for a PitBlk order. No Spruce vendor code:
  // nothing in the reports names it.
  const pit = await prisma.supplier.create({
    data: {
      name: 'Sample Sand & Gravel', type: SupplierType.SUPPLIER, address: '900 Example Sideroad, North Dumfries ON',
      emailDomains: [], emailAddresses: [], keywords: [],
    },
  });
  const haulage = await prisma.supplier.create({
    data: {
      name: 'Demo Haulage Ltd.', type: SupplierType.TRUCKING_COMPANY, address: '3 Truck Stop Lane, Cambridge ON',
      emailDomains: ['demohaulage.example'], emailAddresses: [], keywords: ['demo haulage'],
    },
  });

  // ---- A14: the agreed rates. The pavers' price list words the product its
  // own way, so the invoice line finds it by Spruce item code.
  const ratesFrom = dateOnly(addDays(today, -60));
  await prisma.negotiatedRate.createMany({
    data: [
      { supplierId: pavers.id, productName: 'Charcoal Paver 60mm (price list)', rate: 4.1, unit: 'SQFT', spruceItemCode: 'DPCHAR60', supplierItemCode: 'DP-60-CH', effectiveFrom: ratesFrom, createdById: owner },
      { supplierId: pavers.id, productName: 'Polymeric Sand Grey', rate: 28.5, unit: 'EA', spruceItemCode: 'DPSAND', supplierItemCode: 'DP-PS-GR', effectiveFrom: ratesFrom, createdById: owner },
      { supplierId: aggregates.id, productName: 'A Gravel 19mm', rate: 18, unit: 'tonnes', spruceItemCode: 'AGG19', effectiveFrom: ratesFrom, createdById: owner },
      { supplierId: aggregates.id, productName: 'Screened Sand', rate: 16.5, unit: 'tonnes', spruceItemCode: 'SANDSCR', effectiveFrom: ratesFrom, createdById: owner },
      { supplierId: examplestone.id, productName: 'Examplestone Paver Holland Red', rate: 3.4, unit: 'SQFT', spruceItemCode: 'EXSTONE', effectiveFrom: ratesFrom, createdById: owner },
    ],
  });

  // ---- the morning imports, through the app's own import.
  const first = await runImportBatch(prisma, {
    dispatchDate: yesterday, createdById: users.admin.id, files: morningUpload(yesterdaysOrders(today), yesterday),
  });
  // That upload happened yesterday morning: date it so, or today's board
  // would take its orders for today's upload.
  const yesterdayMorning = at(yesterday, 6, 40);
  await prisma.importBatch.update({
    where: { id: first.batchId },
    data: { createdAt: yesterdayMorning, finishedAt: new Date(yesterdayMorning.getTime() + 60_000) },
  });
  await prisma.orderDocument.updateMany({ where: { lastBatchId: first.batchId }, data: { createdAt: yesterdayMorning } });
  await prisma.order.updateMany({
    where: { document: { lastBatchId: first.batchId } },
    data: { createdAt: yesterdayMorning },
  });

  await runImportBatch(prisma, {
    dispatchDate: today, createdById: users.admin.id, files: morningUpload(todaysOrders(today), today),
  });

  const docs = new Map(
    (await prisma.orderDocument.findMany({ select: { id: true, documentNumber: true } }))
      .map(document => [document.documentNumber, document.id])
  );
  const idOf = (documentNumber: string) => {
    const id = docs.get(documentNumber);
    if (!id) throw new Error(`The demo import did not store ${documentNumber}.`);
    return id;
  };

  // ---- the office's choices, through the order editor.
  // A1: this FOB order is the exception: a CGC truck collects at the FOB yard.
  await applyOrderEdits(idOf(D.fobHauled), parseEditRequest({ fulfilmentOverride: 'supplier_haul_delivery' }), users.admin.id);
  // A5: dispatch names the pit for a PitBlk order.
  await applyOrderEdits(
    idOf(D.pitChosen),
    parseEditRequest({ pickupSupplierId: pit.id, pickupLocation: 'North Dumfries' }),
    users.admin.id
  );

  // ---- yesterday's runs, finished.
  const placedYesterday = at(yesterday, 7, 15);
  const pastPavers = await giveStop(idOf(D.pastPavers), drew, {
    priority: 1, status: 'DELIVERED', placedAt: placedYesterday, completedAt: at(yesterday, 10, 20),
    photo: '/uploads/demo/pod/990051.jpg',
  });
  const pastGravel = await giveStop(idOf(D.pastGravel), dana, {
    priority: 1, status: 'DELIVERED', placedAt: placedYesterday, completedAt: at(yesterday, 9, 40),
    photo: '/uploads/demo/pod/990052.jpg',
  });
  await giveStop(idOf(D.pastTripSand), casey, {
    priority: 1, status: 'DELIVERED', placedAt: placedYesterday, completedAt: at(yesterday, 11, 5),
  });
  await giveStop(idOf(D.pastTripGravel), casey, {
    priority: 2, status: 'DELIVERED', placedAt: placedYesterday, completedAt: at(yesterday, 12, 30),
  });

  // ---- today's runs. The first stop is what each driver's phone shows.
  // Placed this morning and one stop finished since, in that order and never
  // in the future, whatever time the seed is run (an early-morning run must
  // not show a stop finished before it was placed).
  const dayStart = startOfBusinessDay(today)!.getTime();
  const placedToday = new Date(Math.max(dayStart, Math.min(at(today, 6, 55).getTime(), now.getTime() - 60 * 60_000)));
  const doneToday = new Date(
    Math.max(placedToday.getTime() + 60_000, Math.min(now.getTime() - 10 * 60_000, at(today, 9, 10).getTime()))
  );
  await giveStop(idOf(D.yardDoneToday), dana, {
    priority: 1, status: 'DELIVERED', placedAt: placedToday, completedAt: doneToday, photo: '/uploads/demo/pod/990021.jpg',
  });
  await giveStop(idOf(D.fobHauled), dana, { priority: 2, status: 'PLACED', placedAt: placedToday });
  await giveStop(idOf(D.yardRun), dana, { priority: 3, status: 'PLACED', placedAt: placedToday });
  await giveStop(idOf(D.pitChosen), drew, { priority: 1, status: 'PLACED', placedAt: placedToday });
  await giveStop(idOf(D.poDelivery), drew, { priority: 2, status: 'PLACED', placedAt: placedToday });
  await giveStop(idOf(D.tripFirst), casey, { priority: 1, status: 'PLACED', placedAt: placedToday });
  await giveStop(idOf(D.tripSecond), casey, { priority: 2, status: 'PLACED', placedAt: placedToday });

  // ---- A14: loads and haul rates, through the loads service.
  const trip = { carrierSupplierId: haulage.id, rate: '145', rateUnit: 'LOAD', quantity: '1', sourceSupplierId: aggregates.id, tripRef: 'DEMO-TRIP-TODAY' };
  await DispatchLoadsService.create(idOf(D.tripFirst), { ...trip, notes: 'Two POs on one brokered trip' }, users.admin.id);
  await DispatchLoadsService.create(idOf(D.tripSecond), trip, users.admin.id);
  // A carrier but no rate yet: the board's "No haul rate".
  await DispatchLoadsService.create(idOf(D.carrierNoRate), { carrierSupplierId: haulage.id, sourceSupplierId: aggregates.id }, users.admin.id);
  // Yesterday's brokered trip, which the trucking invoice below bills.
  const pastTrip = { carrierSupplierId: haulage.id, rate: '140', rateUnit: 'LOAD', quantity: '1', sourceSupplierId: aggregates.id, tripRef: 'DEMO-TRIP-YESTERDAY' };
  await DispatchLoadsService.create(idOf(D.pastTripSand), { ...pastTrip, ticketNumber: 'DH-1101' }, users.admin.id);
  await DispatchLoadsService.create(idOf(D.pastTripGravel), { ...pastTrip, ticketNumber: 'DH-1102' }, users.admin.id);
  // CGC's own truck with no rate is fine: nobody bills CGC for it.
  await DispatchLoadsService.create(idOf(D.yardRun), { notes: 'Our tandem' }, users.admin.id);

  // This morning's mail, in the order it came, and all of it already in: run
  // before nine, the whole morning moves back so nothing arrives in the future.
  const mailShift = Math.max(0, at(today, 9, 0).getTime() - (now.getTime() - 5 * 60_000));
  const mailAt = (hours: number, minutes = 0) => new Date(at(today, hours, minutes).getTime() - mailShift);

  // ---- tickets: the drivers' photos of yesterday's supplier tickets.
  const lineOf = async (documentNumber: string, product: string) =>
    (await prisma.order.findFirstOrThrow({ where: { documentId: idOf(documentNumber), product }, select: { id: true } })).id;

  const driverTicket = async (input: {
    driverId: string; supplierId: string; ticketNumber: string; documentNumber: string;
    material: string; quantity: number; unit: string;
  }) => {
    const orderId = await lineOf(input.documentNumber, input.material);
    const ticket = await prisma.ticket.create({
      data: {
        source: 'MANUAL',
        ticketNumber: input.ticketNumber,
        supplierId: input.supplierId,
        poNumber: po(input.documentNumber),
        material: input.material,
        quantity: input.quantity,
        unit: input.unit,
        ticketDate: dateOnly(yesterday),
        imageUrl: `/uploads/demo/tickets/${input.ticketNumber}.jpg`,
        ocrRawText: `${input.ticketNumber} ${input.material} ${input.quantity} ${input.unit} PO ${po(input.documentNumber)}`,
        ocrConfidence: 0.94,
        status: 'LINKED',
        linkMethod: 'MANUAL',
        linkedOrderId: orderId,
        driverId: input.driverId,
        receivedAt: at(yesterday, 11, 0),
        deliveryStatus: 'COMPLETED',
      },
    });
    await prisma.ticketOrderMatch.create({ data: { ticketId: ticket.id, orderId, matchMethod: 'MANUAL' } });
    return ticket;
  };

  const paversTicket = await driverTicket({
    driverId: drew.id, supplierId: pavers.id, ticketNumber: 'DP-70001', documentNumber: D.pastPavers,
    material: 'Demo Paver Charcoal 60mm', quantity: 300, unit: 'SQFT',
  });
  await driverTicket({
    driverId: drew.id, supplierId: pavers.id, ticketNumber: 'DP-70002', documentNumber: D.pastPavers,
    material: 'Polymeric Sand Grey', quantity: 6, unit: 'EA',
  });
  await driverTicket({
    driverId: dana.id, supplierId: aggregates.id, ticketNumber: 'DA-33010', documentNumber: D.pastGravel,
    material: 'A Gravel 19mm', quantity: 22, unit: 'tonnes',
  });
  await driverTicket({
    driverId: casey.id, supplierId: aggregates.id, ticketNumber: 'DA-33021', documentNumber: D.pastTripSand,
    material: 'Screened Sand', quantity: 15, unit: 'tonnes',
  });
  await driverTicket({
    driverId: casey.id, supplierId: aggregates.id, ticketNumber: 'DA-33022', documentNumber: D.pastTripGravel,
    material: 'A Gravel 19mm', quantity: 20, unit: 'tonnes',
  });

  // A15: the supplier attached its own copy of DP-70001 to the invoice email,
  // printed its own way. It is linked to the driver's photo, which is the copy
  // that counts, exactly as linkTicketCopies links them on arrival.
  const paversMessage = 'demo-msg-0001';
  const emailedCopy = await prisma.ticket.create({
    data: {
      source: 'EMAIL',
      ticketNumber: 'DP 70001',
      supplierId: pavers.id,
      supplierName: 'Demo Pavers Inc.',
      poNumber: po(D.pastPavers),
      material: 'Demo Paver Charcoal 60mm',
      quantity: 300,
      unit: 'SQFT',
      ticketDate: dateOnly(yesterday),
      imageUrl: '/uploads/demo/tickets/DP-5001-p2.pdf',
      ocrRawText: 'DP 70001 Demo Paver Charcoal 60mm 300 SQFT',
      ocrConfidence: 0.91,
      status: 'UNLINKED',
      receivedAt: mailAt(8, 5),
      emailSourceKey: `${paversMessage}:1#2`,
      duplicateOfTicketId: paversTicket.id,
    },
  });

  // Every ticket through the matching engine, as the OCR handler would.
  for (const ticket of await prisma.ticket.findMany({ select: { id: true }, orderBy: { receivedAt: 'asc' } })) {
    await matchTicketById(ticket.id);
  }

  // ---- invoices, as the inbox would have filed them this morning.
  const receivedAt = mailAt(8, 5);
  const paversInvoice = await prisma.invoice.create({
    data: {
      invoiceNumber: 'DP-5001',
      senderType: SenderType.SUPPLIER,
      supplierId: pavers.id,
      invoiceDate: dateOnly(yesterday),
      dueDate: dateOnly(addDays(today, 29)),
      totalAmount: money((300 * 4.1 + 6 * 31) * 1.13),
      currency: 'CAD',
      fileUrl: '/uploads/demo/invoices/DP-5001.pdf',
      emailFrom: 'billing@demopavers.example',
      emailSubject: 'Invoice DP-5001',
      gmailMessageId: `${paversMessage}:1`,
      receivedAt,
      ocrRawText: 'Demo Pavers Inc. Invoice DP-5001',
      OcrJobStatus: 'COMPLETED',
      lineItems: {
        create: [
          // Found by Spruce item code DPCHAR60: the price list words it differently.
          { lineNumber: 1, description: 'Demo Paver Charcoal 60mm', poNumber: po(D.pastPavers), quantity: 300, unit: 'SQFT', unitRate: 4.1, lineTotal: 1230, flag: 'OK' },
          // Billed above the agreed 28.50.
          { lineNumber: 2, description: 'Polymeric Sand Grey', poNumber: po(D.pastPavers), quantity: 6, unit: 'EA', unitRate: 31, lineTotal: 186, flag: 'OK' },
        ],
      },
      // A12: the Excel that came beside the PDF, kept with it.
      supportingFiles: {
        create: {
          fileUrl: '/uploads/demo/invoices/DP-5001-load-breakdown.xlsx',
          originalName: 'DP-5001-load-breakdown.xlsx',
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 18_432,
          gmailKey: `${paversMessage}:2`,
        },
      },
    },
  });

  const aggregatesMessage = 'demo-msg-0002';
  const excelInvoice = await prisma.invoice.create({
    data: {
      invoiceNumber: 'DA-8801',
      senderType: SenderType.SUPPLIER,
      supplierId: aggregates.id,
      invoiceDate: dateOnly(yesterday),
      totalAmount: money((22 * 18 + 15 * 16.5) * 1.13),
      currency: 'CAD',
      // A12: an .xlsx invoice, read from its cells rather than a PDF.
      fileUrl: '/uploads/demo/invoices/DA-8801.xlsx',
      emailFrom: 'accounts@demoaggregates.example',
      emailSubject: 'Invoice DA-8801 (Excel)',
      gmailMessageId: `${aggregatesMessage}:1`,
      receivedAt: mailAt(7, 50),
      ocrRawText: 'Sheet 1\nInvoice\tDA-8801\nA Gravel 19mm\t22\ttonnes\t18.00\nScreened Sand\t15\ttonnes\t16.50',
      OcrJobStatus: 'COMPLETED',
      lineItems: {
        create: [
          { lineNumber: 1, description: 'A Gravel 19mm', poNumber: po(D.pastGravel), quantity: 22, unit: 'tonnes', unitRate: 18, lineTotal: 396, flag: 'OK' },
          { lineNumber: 2, description: 'Screened Sand', poNumber: po(D.pastTripSand), quantity: 15, unit: 'tonnes', unitRate: 16.5, lineTotal: 247.5, flag: 'OK' },
        ],
      },
    },
  });

  // A14: the trucking company bills yesterday's brokered trip. Dispatch set
  // 140 a load; the second line says 150. The haul-line columns (ticket and
  // service date per line) belong to a later package and are not set here.
  const haulageMessage = 'demo-msg-0003';
  const haulInvoice = await prisma.invoice.create({
    data: {
      invoiceNumber: 'DH-301',
      senderType: SenderType.TRUCKING_COMPANY,
      supplierId: haulage.id,
      invoiceDate: dateOnly(yesterday),
      totalAmount: money((140 + 150) * 1.13),
      currency: 'CAD',
      fileUrl: '/uploads/demo/invoices/DH-301.pdf',
      emailFrom: 'dispatch@demohaulage.example',
      emailSubject: 'Haul invoice DH-301',
      gmailMessageId: `${haulageMessage}:1`,
      receivedAt: mailAt(8, 20),
      ocrRawText: 'Demo Haulage Ltd. Invoice DH-301',
      OcrJobStatus: 'COMPLETED',
      lineItems: {
        create: [
          { lineNumber: 1, description: 'Tri-axle haul, ticket DH-1101', poNumber: po(D.pastTripSand), quantity: 1, unit: 'load', unitRate: 140, lineTotal: 140, flag: 'OK' },
          { lineNumber: 2, description: 'Tri-axle haul, ticket DH-1102', poNumber: po(D.pastTripGravel), quantity: 1, unit: 'load', unitRate: 150, lineTotal: 150, flag: 'OK' },
        ],
      },
    },
  });

  // The verdicts are the engine's own, never written by hand.
  for (const invoice of [paversInvoice, excelInvoice, haulInvoice]) await matchInvoiceById(invoice.id);

  // ---- the mailbox log (A9-A12, A15).
  const toAddress = 'invoices-inbox@demo.invalid';
  const pdf = 'application/pdf';
  const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const events: Prisma.EmailIngestionEventCreateManyInput[] = [
    {
      gmailMessageId: paversMessage, subject: 'Invoice DP-5001', fromAddress: 'billing@demopavers.example', toAddress,
      originalFrom: 'billing@demopavers.example', senderMode: 'direct', supplierId: pavers.id,
      senderTypeResolved: SenderTypeResolved.SUPPLIER, status: EmailIngestionStatus.PROCESSED, receivedAt,
      createdInvoiceIds: [paversInvoice.id], createdTicketIds: [emailedCopy.id],
      attachments: [
        {
          name: 'DP-5001.pdf', mimeType: pdf, size: 96_210, partId: '1', kind: 'pdf', action: 'read', reason: null,
          invoiceId: paversInvoice.id, pages: [{ page: 1, kind: 'invoice' }, { page: 2, kind: 'delivery_ticket' }],
          ticketIds: [emailedCopy.id],
        },
        {
          name: 'DP-5001-load-breakdown.xlsx', mimeType: xlsx, size: 18_432, partId: '2', kind: 'spreadsheet', action: 'read',
          reason: ATTACHMENT_REASONS.supportingFile, supportingInvoiceId: paversInvoice.id,
        },
      ],
    },
    {
      gmailMessageId: aggregatesMessage, subject: 'Invoice DA-8801 (Excel)', fromAddress: 'accounts@demoaggregates.example', toAddress,
      originalFrom: 'accounts@demoaggregates.example', senderMode: 'direct', supplierId: aggregates.id,
      senderTypeResolved: SenderTypeResolved.SUPPLIER, status: EmailIngestionStatus.PROCESSED, receivedAt: mailAt(7, 50),
      createdInvoiceIds: [excelInvoice.id],
      attachments: [
        { name: 'DA-8801.xlsx', mimeType: xlsx, size: 21_004, partId: '1', kind: 'spreadsheet', action: 'read', reason: null, invoiceId: excelInvoice.id, pages: [{ page: 1, kind: 'invoice' }] },
      ],
    },
    {
      gmailMessageId: haulageMessage, subject: 'Haul invoice DH-301', fromAddress: 'dispatch@demohaulage.example', toAddress,
      originalFrom: 'dispatch@demohaulage.example', senderMode: 'direct', supplierId: haulage.id,
      senderTypeResolved: SenderTypeResolved.TRUCKING_COMPANY, status: EmailIngestionStatus.PROCESSED, receivedAt: mailAt(8, 20),
      createdInvoiceIds: [haulInvoice.id],
      attachments: [
        { name: 'DH-301.pdf', mimeType: pdf, size: 54_870, partId: '1', kind: 'pdf', action: 'read', reason: null, invoiceId: haulInvoice.id, pages: [{ page: 1, kind: 'invoice' }] },
      ],
    },
    {
      // A statement: recorded, not billed.
      gmailMessageId: 'demo-msg-0004', subject: 'Monthly statement', fromAddress: 'accounts@demoaggregates.example', toAddress,
      originalFrom: 'accounts@demoaggregates.example', senderMode: 'direct', supplierId: aggregates.id,
      senderTypeResolved: SenderTypeResolved.SUPPLIER, status: EmailIngestionStatus.PROCESSED, receivedAt: mailAt(7, 30),
      attachments: [
        { name: 'statement.pdf', mimeType: pdf, size: 40_112, partId: '1', kind: 'pdf', action: 'skipped', reason: ATTACHMENT_REASONS.statement, pages: [{ page: 1, kind: 'statement' }] },
      ],
    },
    {
      // A11: a sender no supplier record knows waits for the office.
      gmailMessageId: 'demo-msg-0005', subject: 'Invoice 4471', fromAddress: 'invoices@unknown-supplier.example', toAddress,
      originalFrom: 'invoices@unknown-supplier.example', senderMode: 'direct', supplierId: null,
      senderTypeResolved: SenderTypeResolved.UNKNOWN, status: EmailIngestionStatus.NEEDS_REVIEW, reviewReason: 'UNKNOWN_SENDER',
      receivedAt: mailAt(8, 40),
      attachments: [
        { name: 'invoice-4471.pdf', mimeType: pdf, size: 61_330, partId: '1', kind: 'pdf', action: 'held', reason: ATTACHMENT_REASONS.held },
      ],
    },
    {
      // Somebody already looked at this one and set it aside.
      gmailMessageId: 'demo-msg-0006', subject: 'Spring catalogue', fromAddress: 'news@promo-sample.example', toAddress,
      originalFrom: 'news@promo-sample.example', senderMode: 'direct', supplierId: null,
      senderTypeResolved: SenderTypeResolved.UNKNOWN, status: EmailIngestionStatus.IGNORED, reviewReason: 'UNKNOWN_SENDER',
      receivedAt: at(yesterday, 15, 10), reviewedById: owner, reviewedAt: at(yesterday, 16, 0),
      attachments: [
        { name: 'catalogue.pdf', mimeType: pdf, size: 1_204_551, partId: '1', kind: 'pdf', action: 'held', reason: ATTACHMENT_REASONS.held },
      ],
    },
    {
      // A12: the old .xls format, which nothing here can read.
      gmailMessageId: 'demo-msg-0007', subject: 'Invoice DA-8790', fromAddress: 'accounts@demoaggregates.example', toAddress,
      originalFrom: 'accounts@demoaggregates.example', senderMode: 'direct', supplierId: aggregates.id,
      senderTypeResolved: SenderTypeResolved.SUPPLIER, status: EmailIngestionStatus.NEEDS_REVIEW, reviewReason: 'SPREADSHEET',
      receivedAt: mailAt(8, 45),
      attachments: [
        { name: 'DA-8790.xls', mimeType: 'application/vnd.ms-excel', size: 33_280, partId: '1', kind: 'spreadsheet', action: 'review', reason: ATTACHMENT_REASONS.legacyXls },
      ],
    },
  ];
  await prisma.emailIngestionEvent.createMany({ data: events });

  return {
    today,
    users: await prisma.user.count(),
    drivers: await prisma.driver.count(),
    documents: await prisma.orderDocument.count(),
    stops: await prisma.delivery.count(),
    loads: await prisma.dispatchLoad.count(),
    tickets: await prisma.ticket.count(),
    invoices: await prisma.invoice.count(),
    emailEvents: await prisma.emailIngestionEvent.count(),
  };
}

async function main(): Promise<void> {
  assertDemoDatabase();
  const url = new URL(process.env.DATABASE_URL!);
  console.log(`[seedDemo] Seeding ${url.hostname}:${url.port || '5432'}${url.pathname} (every app table is emptied first).`);
  const summary = await seedDemo();
  console.log('[seedDemo] Done:', summary);
  console.log(`[seedDemo] Log in as any of ${Object.values(DEMO_USERS).map(user => user.email).join(', ')}`);
  console.log('[seedDemo] The shared demo password is in docs/local-demo.md.');
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main()
    .catch((error) => {
      console.error('[seedDemo]', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
