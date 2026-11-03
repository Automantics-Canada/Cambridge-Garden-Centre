// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it, mock } from 'node:test';

import { Prisma } from '@prisma/client';
import axios from 'axios';
import ExcelJS from 'exceljs';
import { google } from 'googleapis';
import jwt from 'jsonwebtoken';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { businessDayOf } from '../src/lib/businessDay.js';
import type { BatchFile, BatchSummary } from '../src/modules/orders/import/importBatch.service.js';
import type { ParsedSpruceReport, ParsedSpruceRow, SpruceReportType } from '../src/modules/orders/spruce/spruceReportTypes.js';
import type { ExtractionDocument, ExtractionProvider } from '../src/services/extraction/providers/types.js';

/**
 * The client's fifteen answers of Oct 2026, as one acceptance test.
 *
 * One fictional day at the yard, driven the way the app is used: the morning
 * Spruce reports go through the real import, the office and the drivers work
 * through the HTTP API with their own logins, the invoice inbox is polled
 * through the real poller, files go through the real storage and OCR code,
 * and every verdict comes from the real matching engine against PostgreSQL.
 * Each `describe` is one answer, and its tests say, briefly, what the answer
 * requires.
 *
 * The blocks share the day, so they run in order and build on each other
 * (the price list of A14 prices the invoice of A9, whose emailed tickets
 * A15 reads). They are a scenario, not isolated units; the per-package
 * integration tests cover the edge cases.
 *
 * The external systems are replaced at their seams, and only there:
 *
 *   - Spruce: the reports arrive already read (runImportBatch, the import
 *     route's own service), because pdf2json rejects any PDF a test could
 *     generate (see tests/fixtures/spruceLayouts.ts). The PDF reading itself
 *     is covered by the parser tests.
 *   - Gmail: `google.gmail` is replaced by an in-memory mailbox, as in
 *     tests/gmailPoller.test.ts; Microsoft 365's forwarding rule (A10) is
 *     outside the app, so a forwarded message is built the way Gmail
 *     receives one.
 *   - Supabase Storage: its HTTP calls are answered in memory, and downloads
 *     read back what was uploaded.
 *   - OpenAI: a stand-in extraction provider answers each read with what the
 *     test sets, and records what it was sent (so an Excel invoice can be
 *     seen to arrive as text).
 *   - OCR runs when the test says so (WORKER_MODE=off, then processOcrJob),
 *     so nothing happens in the background behind an assertion.
 *
 * Every name, number, address and amount is invented. Runs only against a
 * disposable loopback database (scripts/run-tests.mjs), which it empties
 * before and after.
 *
 *   CGC_TEST_CONFIRM_DISPOSABLE=1 DATABASE_URL=postgresql://…@127.0.0.1:…/… \
 *     npx tsx --test tests/clientAnswers.acceptance.integration.test.ts
 */

const confirmed = process.env.CGC_TEST_CONFIRM_DISPOSABLE === '1';
const loopback = (() => {
  try {
    return ['127.0.0.1', 'localhost', '::1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname);
  } catch {
    return false;
  }
})();
const runnable = confirmed && loopback;

// OCR runs only when a test asks for it: never in the background.
process.env.WORKER_MODE = 'off';

const here = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ days

const DAY_MS = 24 * 60 * 60 * 1000;
const today = businessDayOf();
const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T12:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
const yesterday = addDays(today, -1);
const tomorrow = addDays(today, 1);
/** A day as Spruce prints it: "11/3/2026". */
const spruceDay = (day: string) => {
  const [year, month, date] = day.split('-').map(Number);
  return `${month}/${date}/${year}`;
};

// ------------------------------------------------------------------ the fictional day

/** Order numbers: Spruce's shape, obviously not Spruce's numbers. */
const D = {
  fobCollects: '8888-770101',
  fobHauled: '8888-770102',
  directWording: '8888-770201',
  quote: '8888-770301',
  quoteTomorrow: '8888-770302',
  poDelivery: '8888-770401',
  tripA: '8888-770402',
  tripB: '8888-770403',
  pitBlk: '8888-770501',
  pitOverPo: '8888-770502',
  slinger: '8888-770601',
  triaxle: '8888-770602',
  reimported: '8888-770701',
  outOfScope: '8888-770798',
  outOfScopeOlder: '8888-770799',
  noPhone: '8888-770801',
  pickupNoPhone: '8888-770802',
  notYetOnDeliveries: '8888-770803',
} as const;

/** A PO per order that buys from a supplier. */
const po = (doc: string) => `8888-66${doc.slice(-4)}`;
const QUOTES: string[] = [D.quote, D.quoteTomorrow];

const VENDOR = { stone: 'FICTIONAL01', pavers: 'PLCPAVE01', aggregates: 'INVAGG01' } as const;
const FORWARDER = 'ap@garden-centre.test';
const INBOX = 'invoices-inbox@garden-centre.test';
const PAVERS_BILLING = 'billing@placeholder-pavers.test';

interface FixtureLine {
  item: string;
  product: string;
  qty: number;
  unit: string;
  price: number;
  po?: string;
  vendor?: string;
  vendorLocation?: string;
}

interface FixtureOrder {
  doc: string;
  customer: string;
  phone: string | null;
  address: string;
  instructions?: string;
  entered: string;
  deliveryDate: string | null;
  /** The Order report's SCH column. */
  scheduled: boolean;
  reports: SpruceReportType[];
  lines: FixtureLine[];
}

const ALL: SpruceReportType[] = ['DELIVERY', 'ORDER_SUMMARY', 'ITEM_TRACKING'];
const NO_DELIVERIES: SpruceReportType[] = ['ORDER_SUMMARY', 'ITEM_TRACKING'];
const comment = (text: string): FixtureLine => ({ item: 'COMMENT', product: text, qty: 1, unit: 'EA', price: 0 });
const charge = (item: string, product: string, price: number): FixtureLine => ({ item, product, qty: 1, unit: 'EA', price });
const delivery = () => charge('MISCDEL', 'Delivery charge', 75);
const soil = (qty: number): FixtureLine => ({ item: 'SOILGRDNA', product: 'Garden Soil Bulk', qty, unit: 'CY', price: 48 });
const mulch = (qty: number): FixtureLine => ({ item: 'MULCHBLK', product: 'Mulch Black Dyed', qty, unit: 'CY', price: 52 });
const stone = (doc: string, product: string, qty: number, unit: string, price: number): FixtureLine =>
  ({ item: 'FICSTONE', product, qty, unit, price, po: po(doc), vendor: VENDOR.stone, vendorLocation: 'Ayr' });
const aggregate = (doc: string, item: string, product: string, qty: number): FixtureLine =>
  ({ item, product, qty, unit: 'MT', price: 32, po: po(doc), vendor: VENDOR.aggregates, vendorLocation: 'Puslinch' });

const CHARCOAL = 'Placeholder Paver Charcoal 60mm';
const POLY_SAND = 'Polymeric Sand Grey';

/** This morning's upload: one order per answer, or two where an answer has two sides. */
function todaysOrders(): FixtureOrder[] {
  const entered = addDays(today, -3);
  return [
    // A1: "FOB <supplier> <yard>": the customer collects there.
    {
      doc: D.fobCollects, customer: 'Pat Imaginary', phone: null, address: '1 Imaginary St, Cambridge',
      entered, deliveryDate: today, scheduled: false, reports: NO_DELIVERIES,
      lines: [comment('FOB FICTIONAL AYR'), stone(D.fobCollects, 'Fictional Patio Slab 24x24', 40, 'EA', 18)],
    },
    // A1, the other 5%: the office sends a CGC truck to the FOB yard.
    {
      doc: D.fobHauled, customer: 'Sam Imaginary', phone: null, address: '2 Imaginary St, Cambridge',
      entered, deliveryDate: today, scheduled: false, reports: NO_DELIVERIES,
      lines: [comment('FOB FICTIONAL AYR'), stone(D.fobHauled, 'Fictional Wall Block', 30, 'EA', 22)],
    },
    // A2: supplier-delivery wording, on today's Deliveries report.
    {
      doc: D.directWording, customer: 'Alex Notreal', phone: '519-555-0201', address: '3 Notreal Way, Kitchener',
      entered, deliveryDate: today, scheduled: true, reports: ALL,
      lines: [stone(D.directWording, 'Fictional Paver Holland Red', 200, 'SQFT', 5.5), charge('MISCDEL', 'Fictional Direct Delivery', 120)],
    },
    // A3: quotations: on Item Tracking only, entered inside the Order report's range.
    {
      doc: D.quote, customer: 'Quinn Quotation', phone: null, address: '4 Estimate Lane, Cambridge',
      entered: today, deliveryDate: today, scheduled: false, reports: ['ITEM_TRACKING'], lines: [soil(6), delivery()],
    },
    {
      doc: D.quoteTomorrow, customer: 'Quincy Quotation', phone: null, address: '5 Estimate Lane, Cambridge',
      entered: today, deliveryDate: tomorrow, scheduled: false, reports: ['ITEM_TRACKING'], lines: [mulch(4), delivery()],
    },
    // A4: a supplier PO: the CGC driver collects at that supplier.
    {
      doc: D.poDelivery, customer: 'Jessie Notreal', phone: '519-555-0401', address: '10 Notreal Court, Cambridge',
      entered, deliveryDate: today, scheduled: true, reports: ALL,
      lines: [
        { item: 'PLCCHAR60', product: CHARCOAL, qty: 300, unit: 'SQFT', price: 6.25, po: po(D.poDelivery), vendor: VENDOR.pavers, vendorLocation: 'Cambridge' },
        { item: 'PLCSAND', product: POLY_SAND, qty: 6, unit: 'EA', price: 42, po: po(D.poDelivery), vendor: VENDOR.pavers, vendorLocation: 'Cambridge' },
        charge('MISCDELD', 'Flatbed delivery', 95),
      ],
    },
    // A4/A14: two POs one brokered truck collects on one trip.
    {
      doc: D.tripA, customer: 'Kai Notreal', phone: '519-555-0402', address: '11 Notreal Concession, Puslinch',
      entered, deliveryDate: today, scheduled: true, reports: ALL,
      lines: [aggregate(D.tripA, 'AGG19', 'A Gravel 19mm', 20), charge('MISCDELT', 'Tri-axle dump charge', 140)],
    },
    {
      doc: D.tripB, customer: 'Lee Notreal', phone: '519-555-0403', address: '12 Notreal Townline, Puslinch',
      entered, deliveryDate: today, scheduled: true, reports: ALL,
      lines: [aggregate(D.tripB, 'SANDSCR', 'Screened Sand', 16), charge('MISCDELT', 'Tri-axle dump charge', 140)],
    },
    // A5: PitBlk, and a PO order dispatch sends to a pit of its choosing.
    {
      doc: D.pitBlk, customer: 'Jamie Notreal', phone: '519-555-0501', address: '13 Notreal Drive, Cambridge',
      entered, deliveryDate: today, scheduled: true, reports: ALL,
      lines: [{ item: 'PITTOPSOIL', product: 'PitBlk Screened Topsoil', qty: 10, unit: 'CY', price: 38 }, delivery()],
    },
    {
      doc: D.pitOverPo, customer: 'Robin Notreal', phone: '519-555-0502', address: '14 Notreal Street, Ayr',
      entered, deliveryDate: today, scheduled: true, reports: ALL,
      lines: [aggregate(D.pitOverPo, 'AGG19', 'A Gravel 19mm', 18), delivery()],
    },
    // A6: a CGC charge, no date, on no Deliveries report: likely delivered already.
    {
      doc: D.slinger, customer: 'Charlie Imaginary', phone: null, address: '15 Imaginary Blvd, Cambridge',
      entered: addDays(today, -9), deliveryDate: null, scheduled: false, reports: NO_DELIVERIES,
      lines: [mulch(8), charge('MISCDELS', 'Slinger truck charge', 160)],
    },
    {
      doc: D.triaxle, customer: 'Frankie Imaginary', phone: null, address: '16 Imaginary Grove, Kitchener',
      entered: addDays(today, -8), deliveryDate: null, scheduled: false, reports: NO_DELIVERIES,
      lines: [soil(12), charge('MISCDELT', 'Tri-axle dump charge', 140)],
    },
    // A7: yesterday's upload had it too; today's changes the quantity.
    {
      doc: D.reimported, customer: 'Riley Imaginary', phone: '519-555-0701', address: '17 Imaginary Crescent, Cambridge',
      instructions: 'Call before, leave at the side gate', entered: addDays(today, -2), deliveryDate: today, scheduled: true,
      reports: ALL, lines: [soil(12), delivery()],
    },
    // A7: entered weeks ago, on Item Tracking only: outside what the day is about.
    {
      doc: D.outOfScope, customer: 'Old Imaginary', phone: null, address: '18 Imaginary Road, Cambridge',
      entered: addDays(today, -25), deliveryDate: null, scheduled: false, reports: ['ITEM_TRACKING'], lines: [soil(2)],
    },
    // A8: on the Deliveries report with the phone left blank.
    {
      doc: D.noPhone, customer: 'Sky Imaginary', phone: null, address: '19 Imaginary Heights, Cambridge',
      entered, deliveryDate: today, scheduled: true, reports: ALL, lines: [mulch(2), delivery()],
    },
    // A8: a yard pickup with no phone, and a delivery not on a Deliveries report yet.
    {
      doc: D.pickupNoPhone, customer: 'Toni Imaginary', phone: null, address: 'PICKUP',
      entered, deliveryDate: null, scheduled: false, reports: NO_DELIVERIES, lines: [soil(1)],
    },
    {
      doc: D.notYetOnDeliveries, customer: 'Val Imaginary', phone: null, address: '20 Imaginary Bend, Cambridge',
      entered, deliveryDate: tomorrow, scheduled: true, reports: NO_DELIVERIES, lines: [soil(3), delivery()],
    },
  ];
}

/** Yesterday's upload: the order re-imported today, and an old Item Tracking row. */
function yesterdaysOrders(): FixtureOrder[] {
  return [
    {
      doc: D.reimported, customer: 'Riley Imaginary', phone: '519-555-0701', address: '17 Imaginary Crescent, Cambridge',
      instructions: 'Leave at the side gate', entered: addDays(today, -2), deliveryDate: today, scheduled: true,
      reports: NO_DELIVERIES, lines: [soil(10), delivery()],
    },
    {
      doc: D.outOfScope, customer: 'Old Imaginary', phone: null, address: '18 Imaginary Road, Cambridge',
      entered: addDays(today, -25), deliveryDate: null, scheduled: false, reports: ['ITEM_TRACKING'], lines: [soil(2)],
    },
  ];
}

/** At noon, Item Tracking again over a wider range: one more month-old order on it. */
function noonOrders(): FixtureOrder[] {
  return [
    ...todaysOrders(),
    {
      doc: D.outOfScopeOlder, customer: 'Older Imaginary', phone: null, address: '21 Imaginary Road, Cambridge',
      entered: addDays(today, -40), deliveryDate: null, scheduled: false, reports: ['ITEM_TRACKING'], lines: [mulch(1)],
    },
  ];
}

const money = (value: number) => Math.round(value * 100) / 100;

/** The rows each report prints for these orders. */
function reportRows(orders: FixtureOrder[], type: SpruceReportType): ParsedSpruceRow[] {
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
          cashier: 'TEST',
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

/**
 * One upload's three reports, as the import screen hands them over once
 * read. `trackingFrom` is how many days back Item Tracking was run: the
 * client asked (Q7) to send a wider range.
 */
function upload(orders: FixtureOrder[], day: string, trackingFrom: number, stamp: string): BatchFile[] {
  const ranges: Record<SpruceReportType, { fromRaw: string; toRaw: string }> = {
    DELIVERY: { fromRaw: spruceDay(day), toRaw: spruceDay(day) },
    ORDER_SUMMARY: { fromRaw: spruceDay(addDays(day, -14)), toRaw: spruceDay(day) },
    ITEM_TRACKING: { fromRaw: spruceDay(addDays(day, -trackingFrom)), toRaw: spruceDay(day) },
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
      fileName: `${reportType.toLowerCase()}-${day}.pdf`,
      // Stands in for the PDF's bytes: only its hash is kept. Item Tracking's
      // stamp differs between uploads, the others' only between days.
      buffer: Buffer.from(reportType === 'ITEM_TRACKING' ? `${stamp}-${reportType}-${day}` : `${reportType}-${day}`),
      report,
    };
  });
}

// ------------------------------------------------------------------ fakes: storage

const STORAGE_HOST = new URL(env.supabaseUrl).hostname;
/** What was uploaded, by storage path. */
const stored = new Map<string, Buffer>();
const realFetch = globalThis.fetch;

/** Supabase Storage over fetch, in memory: uploads are kept, nothing leaves the machine. */
async function storageFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname !== STORAGE_HOST) return realFetch(input, init);
  const marker = `/storage/v1/object/${env.supabaseStorageBucket}/`;
  const at = url.pathname.indexOf(marker);
  if (request.method === 'POST' && at >= 0) {
    const key = decodeURIComponent(url.pathname.slice(at + marker.length));
    stored.set(key, Buffer.from(await request.arrayBuffer()));
    return new Response(JSON.stringify({ Key: `${env.supabaseStorageBucket}/${key}`, Id: key }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
}

/** Downloads of public URLs read back what was uploaded. */
async function storageGet(url: string) {
  const marker = `/storage/v1/object/public/${env.supabaseStorageBucket}/`;
  const pathname = new URL(url).pathname;
  const key = decodeURIComponent(pathname.slice(pathname.indexOf(marker) + marker.length));
  const bytes = stored.get(key);
  if (!bytes) throw Object.assign(new Error(`Nothing stored at ${key}`), { response: { status: 404 } });
  return { data: bytes, status: 200, headers: {} };
}

// ------------------------------------------------------------------ fakes: the model

type Kind = 'invoice' | 'delivery_ticket' | 'statement' | 'credit_memo' | 'other';
/** What the stand-in was asked, in order. */
const asked: Array<{ schemaName: string; filename: string; text: string | undefined }> = [];
/** The next invoice and ticket readings, set by a test before it runs that OCR job. */
const replies: { invoice: unknown; ticket: unknown } = { invoice: null, ticket: null };

/** Sorts pages by file name: a "ticket" file is one ticket page, anything else one invoice page. */
function triageAnswer(filename: string): { pages: Array<{ page: number; kind: Kind }> } {
  return { pages: [{ page: 1, kind: /ticket/i.test(filename) ? 'delivery_ticket' : 'invoice' }] };
}

const standIn: ExtractionProvider = {
  name: 'acceptance-stand-in',
  modelId: 'stand-in',
  async extract<T>(document: ExtractionDocument, _prompt: string, _schema: unknown, schemaName: string): Promise<T> {
    asked.push({ schemaName, filename: document.filename, text: document.text });
    if (schemaName === 'attachment_triage') return triageAnswer(document.filename) as T;
    if (schemaName === 'supplier_invoice') return replies.invoice as T;
    if (schemaName === 'delivery_ticket') return replies.ticket as T;
    throw new Error(`The stand-in has no answer for ${schemaName}`);
  },
};

const invoiceReading = (
  supplierName: string,
  invoiceNumber: string,
  lineItems: Array<{ description: string; quantity: number; unit: string; unitPrice: number; poNumber?: string | null; ticketNumber?: string | null; serviceDate?: string | null }>,
  totalAmount?: number
) => ({
  supplierName,
  invoiceNumber,
  date: today,
  poNumber: null,
  totalAmount: totalAmount ?? money(lineItems.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0) * 1.13),
  lineItems: lineItems.map(line => ({
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    unitPrice: line.unitPrice,
    totalPrice: money(line.quantity * line.unitPrice),
    poNumber: line.poNumber ?? null,
    ticketNumber: line.ticketNumber ?? null,
    serviceDate: line.serviceDate ?? null,
  })),
  readability: 'clear',
  uncertainFields: [],
});

const ticketReading = (ticketNumber: string, material: string, quantity: number, unit: string) => ({
  supplierName: 'Placeholder Pavers Inc.',
  date: today,
  ticketNumber,
  poNumber: po(D.poDelivery),
  material,
  quantity,
  unit,
  readability: 'clear',
  uncertainFields: [],
});

// ------------------------------------------------------------------ fakes: Gmail

type FakePart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { attachmentId?: string; data?: string; size?: number };
  parts?: FakePart[];
};
type FakeMessage = { id: string; labelIds: string[]; internalDate: string; payload: FakePart };

const INVOICE_LABEL = 'cgc-invoices';
const mailbox = {
  labels: [{ id: 'Label_invoices', name: INVOICE_LABEL }] as Array<{ id: string; name: string }>,
  messages: [] as FakeMessage[],
  /** Attachment bytes by `messageId:partId`. */
  contents: new Map<string, Buffer>(),
  downloads: [] as string[],
};

const labelId = (name: string) => mailbox.labels.find(label => label.name.toLowerCase() === name.toLowerCase())?.id;

/** Gmail's search, as far as the poller uses it: labels, excluded labels, unread. */
function matchesQuery(message: FakeMessage, q: string): boolean {
  for (const [, negated, name] of q.matchAll(/(-?)label:"([^"]+)"/g)) {
    const id = labelId(name!);
    const has = id !== undefined && message.labelIds.includes(id);
    if (negated ? has : !has) return false;
  }
  return !/\bis:unread\b/.test(q) || message.labelIds.includes('UNREAD');
}

const fakeGmail = {
  users: {
    getProfile: async () => ({ data: { emailAddress: INBOX } }),
    labels: {
      list: async () => ({ data: { labels: mailbox.labels.map(label => ({ ...label })) } }),
      create: async (args: any) => {
        const label = { id: `Label_${mailbox.labels.length + 1}`, name: args.requestBody.name };
        mailbox.labels.push(label);
        return { data: label };
      },
    },
    messages: {
      list: async (args: any) => {
        const found = mailbox.messages.filter(message => matchesQuery(message, args.q));
        return { data: { messages: found.slice(0, args.maxResults).map(message => ({ id: message.id })) } };
      },
      get: async (args: any) => {
        const message = mailbox.messages.find(m => m.id === args.id);
        if (!message) throw Object.assign(new Error('Requested entity was not found.'), { code: 404 });
        return { data: structuredClone(message) };
      },
      modify: async (args: any) => {
        const message = mailbox.messages.find(m => m.id === args.id)!;
        const remove: string[] = args.requestBody.removeLabelIds ?? [];
        message.labelIds = [...new Set([...message.labelIds, ...(args.requestBody.addLabelIds ?? [])])]
          .filter(id => !remove.includes(id));
        return { data: {} };
      },
      send: async () => ({ data: { id: 'sent' } }),
      attachments: {
        get: async (args: any) => {
          const key = `${args.messageId}:${String(args.id).replace(/^ATT-/, '')}`;
          mailbox.downloads.push(key);
          const content = mailbox.contents.get(key);
          if (!content) throw new Error(`No attachment ${key}`);
          return { data: { data: content.toString('base64url') } };
        },
      },
    },
  },
};
// Before gmail.service is first imported (in `before`), so both of its clients are the fake.
mock.method(google as unknown as { gmail: () => unknown }, 'gmail', () => fakeGmail);

/** A DKIM/SPF pass for the office's own domain, as Gmail records a forward from it. */
const AUTH_PASS =
  'mx.google.com; dkim=pass header.i=@garden-centre.test header.s=s1 header.b=x; ' +
  'spf=pass smtp.mailfrom=ap@garden-centre.test; dmarc=pass (p=NONE) header.from=garden-centre.test';

let messageCount = 0;
/** Puts a labelled, unread message in the inbox, the way Gmail would show it to the poller. */
function deliverMail(options: {
  from: string;
  subject: string;
  text?: string;
  headers?: Record<string, string>;
  attachments: Array<{ filename: string; mimeType: string; content: Buffer }>;
}): string {
  messageCount += 1;
  const id = `acc-msg-${String(messageCount).padStart(3, '0')}`;
  mailbox.messages.push({
    id,
    labelIds: [labelId(INVOICE_LABEL)!, 'UNREAD', 'INBOX'],
    internalDate: String(Date.now()),
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: options.from },
        { name: 'To', value: INBOX },
        { name: 'Subject', value: options.subject },
        ...Object.entries(options.headers ?? {}).map(([name, value]) => ({ name, value })),
      ],
      parts: [
        { partId: '0', mimeType: 'text/plain', body: { data: Buffer.from(options.text ?? 'Invoice attached.').toString('base64url') } },
        ...options.attachments.map((attachment, index) => {
          const partId = String(index + 1);
          mailbox.contents.set(`${id}:${partId}`, attachment.content);
          return {
            partId,
            mimeType: attachment.mimeType,
            filename: attachment.filename,
            body: { attachmentId: `ATT-${partId}`, size: attachment.content.length },
          };
        }),
      ],
    },
  });
  return id;
}

const labelsOf = (id: string) =>
  mailbox.messages.find(m => m.id === id)!.labelIds.map(l => mailbox.labels.find(x => x.id === l)?.name ?? l);

const PDF_TYPE = 'application/pdf';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function pdf(text: string): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage([400, 300]).drawText(text, { x: 20, y: 150, font, size: 14 });
  return Buffer.from(await document.save());
}

const ticketPhoto = readFileSync(path.join(here, 'fixtures', 'synthetic-ticket.png'));

// ------------------------------------------------------------------ the app

let server: Server;
let baseUrl: string;
type Role = 'OWNER' | 'ADMIN' | 'AP_USER' | 'DRIVER_1' | 'DRIVER_2' | 'DRIVER_3';
const tokens = {} as Record<Role, string>;
const userIds = {} as Record<Role, string>;
const drivers = {} as Record<'dana' | 'drew' | 'devon' | 'casey', string>;
const suppliers = {} as Record<'stone' | 'pavers' | 'pit' | 'aggregates' | 'haulage', string>;
const summaries = {} as Record<'yesterday' | 'morning' | 'noon', BatchSummary>;
/** Shared by the blocks of the day, in the order they run. */
let paversMessage = '';
let unknownMessage = '';
let paversInvoiceId = '';
let haulInvoiceId = '';
let unpricedLoadId = '';

async function api(method: string, route: string, body?: unknown, role: Role = 'AP_USER') {
  const response = await realFetch(`${baseUrl}${route}`, {
    method,
    headers: { Authorization: `Bearer ${tokens[role]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function apiUpload(route: string, file: { bytes: Buffer; name: string; type?: string }, fields: Record<string, string>, role: Role) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file.bytes)], file.type ? { type: file.type } : {}), file.name);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const response = await realFetch(`${baseUrl}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${tokens[role]}` }, body: form });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const idOf = async (documentNumber: string) =>
  (await prisma.orderDocument.findUniqueOrThrow({ where: { documentNumber }, select: { id: true } })).id;

const board = async () => (await api('GET', `/api/dispatch?date=${today}`)).body;
type BoardRow = { id: string; spruceOrderId: string; [key: string]: any };
const poolRow = (b: { unassignedOrders: BoardRow[] }, documentNumber: string) =>
  b.unassignedOrders.find(row => row.spruceOrderId === documentNumber);
const everyRow = (b: { unassignedOrders: BoardRow[]; carriedOver: BoardRow[]; drivers: Array<{ deliveries: Array<{ order: BoardRow }> }> }) => [
  ...b.unassignedOrders,
  ...b.carriedOver,
  ...b.drivers.flatMap(driver => driver.deliveries.map(stop => stop.order)),
];

/** The driver's phone: their current stop, through the driver's own login. */
async function currentStop(role: Role) {
  const response = await api('GET', '/api/deliveries', undefined, role);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assertNoMoney(response.body, `${role} current stop`);
  return response.body[0];
}

/**
 * Every key that would put money in front of a driver (as
 * tests/driverPricePrivacy.integration.test.ts): prices, costs, the office's
 * supplier records, and the haul rates and carriers dispatch records.
 */
const MONEY_KEYS = [
  'unitPrice', 'unitCost', 'poValue', 'totalWithTax', 'remaining', 'remainingDeposit', 'grossMarginPct', 'supplier',
  'supplierId', 'supplierName', 'awaitingSupplier', 'poNumber', 'vendorCode', 'vendorLocation',
  'haulLoads', 'dispatchLoads', 'rate', 'rateUnit', 'carrierSupplierId', 'carrierSupplier', 'carrierName',
  'claimedByLineItemId', 'tripRef', 'negotiatedRate', 'approvedTotal', 'lineTotal', 'unitRate',
];

function moneyKeysIn(value: unknown, at = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => moneyKeysIn(item, `${at}[${index}]`));
  if (value === null || typeof value !== 'object' || value instanceof Date) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(MONEY_KEYS.includes(key) ? [`${at}.${key}`] : []),
    ...moneyKeysIn(child, `${at}.${key}`),
  ]);
}

function assertNoMoney(payload: unknown, what: string) {
  assert.deepEqual(moneyKeysIn(payload), [], `${what} must carry no prices, rates or supplier money`);
}

/** Every table of the app, from the schema. */
const appTables = () => Prisma.dmmf.datamodel.models.map(model => model.dbName ?? model.name);

async function wipe(): Promise<void> {
  if (!runnable) throw new Error('Refusing to empty a database that is not a confirmed loopback one');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${appTables().map(table => `"${table}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

async function rowCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of appTables()) {
    const [row] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*) AS count FROM "${table}"`);
    counts[table] = Number(row!.count);
  }
  return counts;
}

// Loaded in `before`, after the fakes are in place.
let GmailService: typeof import('../src/services/gmail.service.js').GmailService;
let readGmailInboxConfig: typeof import('../src/config/gmailConfig.js').readGmailInboxConfig;
let processOcrJob: typeof import('../src/services/ocrJobProcessor.js').processOcrJob;
let invalidateKnownSenders: typeof import('../src/services/knownSenders.js').invalidateKnownSenders;
let waitForRateRechecks: typeof import('../src/modules/supplier/rateRecheck.js').waitForRateRechecks;
/** OCR jobs the poller would have started, by invoice. */
const queuedOcr: string[] = [];

const inboxConfig = (overrides: Record<string, string> = {}) => readGmailInboxConfig({
  GMAIL_INBOX_CLIENT_ID: 'inbox-client-id.test',
  GMAIL_INBOX_CLIENT_SECRET: 'inbox-client-secret-test',
  GMAIL_INBOX_REFRESH_TOKEN: 'inbox-refresh-token-test',
  GMAIL_INVOICE_LABEL: INVOICE_LABEL,
  GMAIL_TRUSTED_FORWARDERS: FORWARDER,
  // Required: without a go-live date the poller reads and labels nothing.
  GMAIL_POLL_AFTER: '2026-01-01',
  ...overrides,
});

async function poll(overrides: Record<string, string> = {}) {
  invalidateKnownSenders();
  await GmailService.pollInvoices(inboxConfig(overrides));
}

/** Runs one OCR job, with the reading the stand-in gives back. */
async function runOcr(jobId: string, reading: { invoice?: unknown; ticket?: unknown }) {
  if (reading.invoice !== undefined) replies.invoice = reading.invoice;
  if (reading.ticket !== undefined) replies.ticket = reading.ticket;
  await processOcrJob(jobId);
  const job = await prisma.ocrJob.findUniqueOrThrow({ where: { id: jobId } });
  assert.equal(job.status, 'COMPLETED', job.errorMessage ?? '');
}

const ocrJobOfInvoice = async (invoiceId: string) =>
  (await prisma.ocrJob.findFirstOrThrow({ where: { invoiceId }, select: { id: true } })).id;
const ocrJobOfTicket = async (ticketId: string) =>
  (await prisma.ocrJob.findFirstOrThrow({ where: { ticketId }, select: { id: true } })).id;

const lineVerdicts = (invoiceId: string) =>
  prisma.invoiceLineItem.findMany({
    where: { invoiceId },
    include: { matchResult: true },
    orderBy: { lineNumber: 'asc' },
  });
type Check = { name: string; passed: boolean; code?: string; detail: string; found?: unknown };
const check = (verdict: { evidence: unknown } | null, name: string) =>
  (verdict?.evidence as Check[] | undefined)?.find(entry => entry.name === name);

// ================================================================== the day

describe('client answers of Oct 2026: one day at the yard (PostgreSQL)', { skip: !runnable }, () => {
  before(async () => {
    await wipe();

    globalThis.fetch = storageFetch as typeof fetch;
    mock.method(axios, 'get', storageGet);
    const extraction = await import('../src/services/extraction/extraction.service.js');
    extraction.setExtractionProviderForTests(standIn);

    ({ GmailService } = await import('../src/services/gmail.service.js'));
    ({ readGmailInboxConfig } = await import('../src/config/gmailConfig.js'));
    ({ processOcrJob } = await import('../src/services/ocrJobProcessor.js'));
    ({ invalidateKnownSenders } = await import('../src/services/knownSenders.js'));
    ({ waitForRateRechecks } = await import('../src/modules/supplier/rateRecheck.js'));
    GmailService.resetState();
    GmailService.triggerOcr = (jobId: string) => { queuedOcr.push(jobId); };

    // ---- people
    for (const role of ['OWNER', 'ADMIN', 'AP_USER', 'DRIVER_1', 'DRIVER_2', 'DRIVER_3'] as const) {
      const user = await prisma.user.create({
        data: {
          name: `Acceptance ${role}`, email: `${role.toLowerCase().replace('_', '-')}@acceptance.invalid`, passwordHash: 'x',
          role: role.startsWith('DRIVER') ? 'DRIVER' : (role as 'OWNER' | 'ADMIN' | 'AP_USER'),
        },
      });
      userIds[role] = user.id;
      tokens[role] = jwt.sign({ id: user.id, email: user.email, role: user.role }, env.jwtSecret);
    }
    drivers.dana = (await prisma.driver.create({ data: { name: 'Dana Testdriver', phone: '519-555-0011', type: 'CGC_FLEET', userId: userIds.DRIVER_1 } })).id;
    drivers.drew = (await prisma.driver.create({ data: { name: 'Drew Testdriver', phone: '519-555-0012', type: 'CGC_FLEET', userId: userIds.DRIVER_2 } })).id;
    drivers.devon = (await prisma.driver.create({ data: { name: 'Devon Testdriver', phone: '519-555-0013', type: 'CGC_FLEET', userId: userIds.DRIVER_3 } })).id;
    // A4: the truck the client brokers. No login: dispatch records its loads.
    drivers.casey = (await prisma.driver.create({
      data: { name: 'Casey Broker', phone: '519-555-0014', type: 'INDEPENDENT', companyName: 'Hypothetical Haulage Ltd.' },
    })).id;

    // ---- suppliers
    const supplier = (data: Prisma.SupplierCreateInput) => prisma.supplier.create({ data });
    suppliers.stone = (await supplier({
      name: 'Fictional Stoneworks Ltd.', type: 'SUPPLIER', address: '10 Imaginary Quarry Rd, Ayr ON',
      emailDomains: ['fictional-stone.test'], emailAddresses: [], keywords: [], spruceVendors: { create: { code: VENDOR.stone } },
    })).id;
    suppliers.pavers = (await supplier({
      name: 'Placeholder Pavers Inc.', type: 'SUPPLIER', address: '20 Sample Paver Way, Cambridge ON',
      emailDomains: [], emailAddresses: [PAVERS_BILLING], keywords: [], spruceVendors: { create: { code: VENDOR.pavers } },
    })).id;
    suppliers.aggregates = (await supplier({
      name: 'Invented Aggregates Ltd.', type: 'SUPPLIER', address: '40 Test Pit Rd, Puslinch ON',
      emailDomains: [], emailAddresses: [], keywords: [], spruceVendors: { create: { code: VENDOR.aggregates } },
    })).id;
    // A5: the pit dispatch chooses. Nothing in the reports names it.
    suppliers.pit = (await supplier({
      name: 'Notional Sand & Gravel', type: 'SUPPLIER', address: '30 Example Sideroad, North Dumfries ON',
      emailDomains: [], emailAddresses: [], keywords: [],
    })).id;
    suppliers.haulage = (await supplier({
      name: 'Hypothetical Haulage Ltd.', type: 'TRUCKING_COMPANY', address: '50 Truck Stop Lane, Cambridge ON',
      emailDomains: ['hypothetical-haulage.test'], emailAddresses: [], keywords: [],
    })).id;

    const { default: app } = await import('../src/app.js');
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // ---- the Spruce reports, through the import (A7: a month of Item Tracking each time).
    const { runImportBatch } = await import('../src/modules/orders/import/importBatch.service.js');
    summaries.yesterday = await runImportBatch(prisma, {
      dispatchDate: yesterday, createdById: userIds.ADMIN, files: upload(yesterdaysOrders(), yesterday, 31, 'yesterday'),
    });
    // That upload happened yesterday morning: dated so, or today's board would
    // take its orders for today's upload.
    const yesterdayMorning = new Date(Date.now() - DAY_MS);
    await prisma.importBatch.update({ where: { id: summaries.yesterday.batchId }, data: { createdAt: yesterdayMorning } });
    await prisma.orderDocument.updateMany({ where: { lastBatchId: summaries.yesterday.batchId }, data: { createdAt: yesterdayMorning } });

    summaries.morning = await runImportBatch(prisma, {
      dispatchDate: today, createdById: userIds.ADMIN, files: upload(todaysOrders(), today, 30, 'morning'),
    });
    // Run again at noon over a wider range, as the client may now do.
    summaries.noon = await runImportBatch(prisma, {
      dispatchDate: today, createdById: userIds.ADMIN, files: upload(noonOrders(), today, 45, 'noon'),
    });
  });

  after(async () => {
    globalThis.fetch = realFetch;
    server?.close();
    // Later suites truncate only the tables they use: leave none of this day behind.
    if (runnable) await wipe();
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------- A1

  describe('A1: FOB + supplier means the customer collects there (95%)', () => {
    it('A1: an FOB order is the customer\'s to collect: off the pools, the board and the day\'s counts', async () => {
      const stored = await prisma.orderDocument.findUniqueOrThrow({ where: { documentNumber: D.fobCollects } });
      assert.equal(stored.isPickup, true);

      const summarised = summaries.morning.orders.find(order => order.documentNumber === D.fobCollects);
      assert.equal(summarised?.isPickup, true);
      assert.equal(summaries.morning.onBoard, summaries.morning.orders.filter(order => !order.isPickup).length);

      const day = await board();
      assert.equal(poolRow(day, D.fobCollects), undefined, 'not work for a driver');
      assert.ok(!everyRow(day).some(row => row.spruceOrderId === D.fobCollects));
      // Yet the Orders page lists it, as the customer's own collection.
      const listed = await api('GET', `/api/orders/documents?search=${D.fobCollects}`);
      assert.equal(listed.body.data[0]?.fulfilment?.type, 'external_pickup');
      assert.equal(listed.body.data[0]?.fulfilment?.places[0]?.name, 'Fictional');
    });

    it('A1: the other 5%: the office sends a truck, and the driver loads at the FOB yard', async () => {
      const id = await idOf(D.fobHauled);
      assert.equal(poolRow(await board(), D.fobHauled), undefined, 'off the board until the office says otherwise');

      const edited = await api('PATCH', `/api/orders/documents/${id}`, { fulfilmentOverride: 'supplier_haul_delivery' });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      const row = poolRow(await board(), D.fobHauled);
      assert.ok(row, 'on today\'s board now');
      assert.equal(row.fulfilment.type, 'supplier_haul_delivery');

      assert.equal((await api('POST', '/api/dispatch/assign', { documentId: id, driverId: drivers.dana })).status, 200);
      const stop = await currentStop('DRIVER_1');
      assert.equal(stop.document.documentNumber, D.fobHauled);
      // The FOB yard and its PO, with the supplier's address there: not CGC's yard.
      assert.deepEqual(stop.pickupFrom, [
        { name: 'Fictional', location: 'Ayr', address: '10 Imaginary Quarry Rd, Ayr ON', po: po(D.fobHauled) },
      ]);
      assert.equal(stop.pickupAtPit, false);
    });
  });

  // ---------------------------------------------------------------- A2

  describe('A2: suppliers can deliver, but CGC usually delivers or brokers', () => {
    it('A2: "Direct Delivery" wording keeps the order on the board, marked for staff to confirm', async () => {
      const row = poolRow(await board(), D.directWording)!;
      assert.ok(row, 'still CGC work');
      assert.ok(row.fulfilment.checks.includes('SUPPLIER_DELIVERY_NOTED'));
      assert.notEqual(row.fulfilment.type, 'supplier_direct_ship');
    });

    it('A2: only the office makes it a direct ship, and then it leaves the board', async () => {
      const id = await idOf(D.directWording);
      const edited = await api('PATCH', `/api/orders/documents/${id}`, { fulfilmentOverride: 'supplier_direct_ship' });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.equal(poolRow(await board(), D.directWording), undefined);
      const listed = await api('GET', `/api/orders/documents?search=${D.directWording}`);
      assert.equal(listed.body.data[0]?.fulfilment?.type, 'supplier_direct_ship', 'still on the Orders page');
    });
  });

  // ---------------------------------------------------------------- A3

  describe('A3: 721522 is a quotation; quotations off the dashboard', () => {
    it('A3: a quotation is flagged, left out of the import\'s counts, and never reaches the dispatch board', async () => {
      for (const number of [D.quote, D.quoteTomorrow]) {
        const stored = await prisma.orderDocument.findUniqueOrThrow({ where: { documentNumber: number } });
        assert.ok(stored.flags.includes('QUOTE'), `${number} is a quotation`);
      }
      assert.deepEqual([...(summaries.morning.quoteNumbers ?? [])].sort(), [D.quote, D.quoteTomorrow]);
      assert.ok(!summaries.morning.orders.some(order => order.documentNumber === D.quote));

      const day = await board();
      assert.ok(!everyRow(day).some(row => QUOTES.includes(row.spruceOrderId)));
      const upcoming = (await api('GET', '/api/dispatch/upcoming')).body as Array<{ date: string; count: number; unassigned: number }>;
      const tomorrowRow = upcoming.find(day => day.date === tomorrow);
      // Tomorrow has one real order (A8's), not the quotation.
      assert.deepEqual(tomorrowRow && { count: tomorrowRow.count, unassigned: tomorrowRow.unassigned }, { count: 1, unassigned: 1 });
      const undated = (await api('GET', '/api/dispatch/pickups')).body as BoardRow[];
      assert.ok(!undated.some(row => QUOTES.includes(row.spruceOrderId)));
    });

    it('A3: dispatching a quotation is refused (409)', async () => {
      const refused = await api('POST', '/api/dispatch/assign', { documentId: await idOf(D.quote), driverId: drivers.dana });
      assert.equal(refused.status, 409);
      assert.match(refused.body.error, /quotation/);
      assert.equal(await prisma.delivery.count({ where: { document: { documentNumber: D.quote } } }), 0);
    });

    it('A3: a quotation is never a matching candidate, nor offered in the link pickers', async () => {
      // The pickers' list leaves its lines out.
      const picker = await api('GET', `/api/orders?search=${D.quote}`);
      assert.equal(picker.status, 200);
      assert.deepEqual(picker.body.data, []);

      // Linking an invoice line to it by hand is refused.
      const quoteLine = await prisma.order.findFirstOrThrow({ where: { document: { documentNumber: D.quote } } });
      const invoice = await prisma.invoice.create({
        data: {
          invoiceNumber: 'ACC-Q-1', senderType: 'SUPPLIER', supplierId: suppliers.pit, invoiceDate: new Date(`${today}T00:00:00Z`),
          totalAmount: 1, currency: 'CAD', fileUrl: '/uploads/none.pdf', emailFrom: PAVERS_BILLING, emailSubject: 'x', gmailMessageId: 'acc-q-1',
          lineItems: { create: { lineNumber: 1, description: 'Garden Soil Bulk', quantity: 6, unit: 'CY', unitRate: 1, lineTotal: 6, flag: 'OK' } },
        },
        include: { lineItems: true },
      });
      const link = await api('POST', '/api/invoices/line-items/link-order', { lineItemId: invoice.lineItems[0]!.id, orderId: quoteLine.id });
      assert.ok(link.status >= 400 && link.status < 500, JSON.stringify(link.body));
      assert.match(link.body.error, /quotation/);

      // The engine's candidates: a quotation line attributed to a supplier is
      // never offered for that supplier's ticket. (The import does not set a
      // line's supplier; it is set here to reach the supplier-and-date route.)
      await prisma.order.update({ where: { id: quoteLine.id }, data: { supplierId: suppliers.pit, orderDate: new Date(`${today}T00:00:00Z`) } });
      const ticket = await prisma.ticket.create({
        data: {
          source: 'MANUAL', supplierId: suppliers.pit, material: 'Garden Soil Bulk', quantity: 6, unit: 'CY',
          ticketDate: new Date(`${today}T00:00:00Z`), imageUrl: '/uploads/none.png', ocrRawText: '', ocrConfidence: 0.9, status: 'UNLINKED',
        },
      });
      const { matchTicketById, matchInvoiceLineById } = await import('../src/modules/matching/matching.service.js');
      const verdict = await matchTicketById(ticket.id);
      assert.equal(verdict?.orderId, null);
      assert.ok(!verdict?.candidateOrderIds.includes(quoteLine.id));
      // Nor for that supplier's invoice line, by the same supplier-and-date route.
      const lineVerdict = await matchInvoiceLineById(invoice.lineItems[0]!.id);
      assert.equal(lineVerdict?.orderId, null);
      assert.ok(!lineVerdict?.candidateOrderIds.includes(quoteLine.id));

      // And the desk cannot point the line's verdict at it by override either.
      const result = await prisma.matchResult.findUniqueOrThrow({ where: { invoiceLineId: invoice.lineItems[0]!.id } });
      const overridden = await api('POST', `/api/matching/results/${result.id}/resolve`, {
        resolution: 'OVERRIDDEN', orderId: quoteLine.id, note: 'This is the soil order',
      });
      assert.equal(overridden.status, 409, JSON.stringify(overridden.body));
      assert.match(overridden.body.error, /quotation/);
      assert.equal((await prisma.matchResult.findUniqueOrThrow({ where: { id: result.id } })).resolution, null);
      await prisma.order.update({ where: { id: quoteLine.id }, data: { supplierId: null } });
      await prisma.ticket.delete({ where: { id: ticket.id } });
      await prisma.invoiceLineItem.deleteMany({ where: { invoiceId: invoice.id } });
      await prisma.invoice.delete({ where: { id: invoice.id } });
    });

    it('A3: the Orders page lists quotations only when asked (quotes=only)', async () => {
      const normal = (await api('GET', '/api/orders/documents?limit=100')).body.data as BoardRow[];
      assert.ok(!normal.some(row => QUOTES.includes(row.spruceOrderId)));
      const quotes = (await api('GET', '/api/orders/documents?quotes=only&limit=100')).body.data as BoardRow[];
      assert.deepEqual(quotes.map(row => row.spruceOrderId).sort(), [D.quote, D.quoteTomorrow]);
    });
  });

  // ---------------------------------------------------------------- A4

  describe('A4: a PO attached means CGC collects at the supplier (~90%), sometimes on a brokered truck', () => {
    it('A4: the driver\'s "Pick up first" names the supplier, its yard and the PO to quote', async () => {
      const id = await idOf(D.poDelivery);
      const stored = await prisma.orderDocument.findUniqueOrThrow({ where: { id } });
      assert.ok(!stored.flags.includes('CHECK_PICKUP_POINT'), 'a PO means we collect: nothing to check');

      assert.equal((await api('POST', '/api/dispatch/assign', { documentId: id, driverId: drivers.drew })).status, 200);
      const stop = await currentStop('DRIVER_2');
      assert.equal(stop.document.documentNumber, D.poDelivery);
      assert.deepEqual(stop.pickupFrom, [
        { name: 'Placeholder Pavers Inc.', location: 'Cambridge', address: '20 Sample Paver Way, Cambridge ON', po: po(D.poDelivery) },
      ]);
    });

    it('A4: one brokered (INDEPENDENT) truck takes two POs on one trip', async () => {
      for (const number of [D.tripA, D.tripB]) {
        assert.equal((await api('POST', '/api/dispatch/assign', { documentId: await idOf(number), driverId: drivers.casey })).status, 200);
        const load = await api('POST', `/api/dispatch/orders/${await idOf(number)}/loads`, {
          carrierSupplierId: suppliers.haulage, rateUnit: 'LOAD', quantity: '1', tripRef: 'ACC-TRIP-1',
          ...(number === D.tripA ? { rate: '150', ticketNumber: 'HH-T1' } : {}),
        });
        assert.equal(load.status, 201, JSON.stringify(load.body));
        // The brokered driver is named on the load: they do not use the app.
        assert.equal(load.body.driverId, drivers.casey);
      }
      const casey = (await board()).drivers.find((driver: { id: string }) => driver.id === drivers.casey);
      assert.deepEqual(casey.deliveries.map((stop: { order: BoardRow }) => stop.order.spruceOrderId), [D.tripA, D.tripB]);
      for (const stop of casey.deliveries) {
        assert.equal(stop.order.haulLoads[0].trip.loads, 2, 'one trip, two orders');
        assert.equal(stop.order.pickupFrom[0].name, 'Invented Aggregates Ltd.');
      }
    });
  });

  // ---------------------------------------------------------------- A5

  describe('A5: dispatch decides the pit for PitBlk', () => {
    it('A5: a PitBlk order with no pit named asks for one, and the driver is told to ask dispatch', async () => {
      const id = await idOf(D.pitBlk);
      const row = poolRow(await board(), D.pitBlk)!;
      assert.ok(row.fulfilment.checks.includes('NO_SUPPLIER_PO'));
      assert.equal((await api('POST', '/api/dispatch/assign', { documentId: id, driverId: drivers.devon })).status, 200);
      const stop = await currentStop('DRIVER_3');
      assert.deepEqual(stop.pickupFrom, []);
      assert.equal(stop.pickupAtPit, true, 'never sent to CGC\'s yard');
    });

    it('A5: the dispatcher names the pit; the driver\'s phone shows its name and address', async () => {
      const id = await idOf(D.pitBlk);
      const edited = await api('PATCH', `/api/orders/documents/${id}`, { pickupSupplierId: suppliers.pit, pickupLocation: 'North Dumfries' });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      const stop = await currentStop('DRIVER_3');
      assert.deepEqual(stop.pickupFrom, [
        { name: 'Notional Sand & Gravel', location: 'North Dumfries', address: '30 Example Sideroad, North Dumfries ON', po: null },
      ]);
      assert.equal(stop.pickupAtPit, false);
    });

    it('A5: the office\'s choice of pit beats the vendor on the order\'s PO', async () => {
      const id = await idOf(D.pitOverPo);
      assert.equal(poolRow(await board(), D.pitOverPo)!.pickupFrom[0].name, 'Invented Aggregates Ltd.', 'the PO vendor until dispatch says');
      const edited = await api('PATCH', `/api/orders/documents/${id}`, { pickupSupplierId: suppliers.pit });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      const row = poolRow(await board(), D.pitOverPo)!;
      assert.deepEqual(row.pickupFrom.map((place: { name: string }) => place.name), ['Notional Sand & Gravel']);
      assert.equal(row.fulfilment.signal.id, 'H2');
    });
  });

  // ---------------------------------------------------------------- A6

  describe('A6: any order with a delivery charge is a delivery; likely done already when not on the Deliveries report', () => {
    it('A6: charge-only orders with no date import as deliveries, flagged "not on a Deliveries report"', async () => {
      for (const [number, type] of [[D.slinger, 'SLINGER'], [D.triaxle, 'DUMP']] as const) {
        const stored = await prisma.orderDocument.findUniqueOrThrow({ where: { documentNumber: number } });
        assert.equal(stored.isPickup, false, `${number} is a delivery`);
        assert.equal(stored.deliveryDate, null);
        assert.equal(stored.deliveryType, type);
      }
    });

    it('A6: on today\'s board they sit in the likely-delivered group, apart from the day\'s work', async () => {
      const day = await board();
      for (const number of [D.slinger, D.triaxle]) {
        const row = poolRow(day, number);
        assert.ok(row, `${number} is still on today's board`);
        assert.equal(row.likelyDelivered, true);
        assert.ok(row.fulfilment.checks.includes('NOT_ON_DELIVERIES_REPORT'));
      }
      assert.equal(poolRow(day, D.noPhone)?.likelyDelivered, false, 'real work is not');
    });

    it('A6: "Done outside the app" marks it delivered, audited, and off the board; a driver may not', async () => {
      const id = await idOf(D.slinger);
      assert.equal((await api('POST', `/api/dispatch/orders/${id}/done-outside-app`, undefined, 'DRIVER_1')).status, 403);
      const done = await api('POST', `/api/dispatch/orders/${id}/done-outside-app`, undefined, 'AP_USER');
      assert.equal(done.status, 200, JSON.stringify(done.body));
      const stop = await prisma.delivery.findUniqueOrThrow({ where: { documentId: id } });
      assert.equal(stop.status, 'DELIVERED');
      assert.ok(stop.completedAt);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: id } });
      assert.equal(audit.performedById, userIds.AP_USER);
      assert.equal((audit.details as { action: string }).action, 'DONE_OUTSIDE_APP');
      assert.equal(poolRow(await board(), D.slinger), undefined);
    });
  });

  // ---------------------------------------------------------------- A7

  describe('A7: a wider Item Tracking range, re-imported, without duplicates', () => {
    it('A7: overlapping uploads leave one order and one set of lines, with the later quantity', async () => {
      assert.equal(await prisma.importBatch.count(), 3);
      const reimported = await prisma.orderDocument.findUniqueOrThrow({
        where: { documentNumber: D.reimported }, include: { lines: true },
      });
      assert.equal(reimported.lines.length, 2);
      assert.equal(Number(reimported.lines.find(line => line.spruceItemNumber === 'SOILGRDNA')?.quantity), 12);

      // Every line of every order, once: as many lines as the day's orders have.
      const expected = todaysOrders().filter(order => order.doc !== D.outOfScope);
      assert.equal(await prisma.orderDocument.count(), expected.length);
      assert.equal(await prisma.order.count(), expected.reduce((sum, order) => sum + order.lines.length, 0));
    });

    it('A7: rows outside the day\'s scope are read, counted and not used', async () => {
      assert.equal(await prisma.orderDocument.count({ where: { documentNumber: { in: [D.outOfScope, D.outOfScopeOlder] } } }), 0);
      const all = noonOrders().filter(order => order.reports.includes('ITEM_TRACKING'));
      assert.deepEqual(
        { read: summaries.noon.itemTracking?.documentsRead, used: summaries.noon.itemTracking?.documentsUsed },
        { read: all.length, used: all.length - 2 }
      );
      assert.equal(summaries.noon.itemTracking?.dateFrom, addDays(today, -45));
      assert.equal(summaries.yesterday.itemTracking?.documentsUsed, 1, 'yesterday, only the order the day was about');
    });
  });

  // ---------------------------------------------------------------- A8

  describe('A8: the phone is on the Deliveries report', () => {
    it('A8: NO_PHONE only once the order has been on a Deliveries report', async () => {
      const flags = async (number: string) => (await prisma.orderDocument.findUniqueOrThrow({ where: { documentNumber: number } })).flags;
      assert.ok((await flags(D.noPhone)).includes('NO_PHONE'));
      assert.ok(!(await flags(D.notYetOnDeliveries)).includes('NO_PHONE'), 'not on a Deliveries report yet');
      assert.ok(!(await flags(D.pickupNoPhone)).includes('NO_PHONE'), 'a pickup');
    });

    it('A8: the Orders page\'s "Missing: Phone" lists exactly those, for examples from the live app', async () => {
      const missing = await api('GET', '/api/orders/documents?missing=phone&limit=100');
      assert.equal(missing.status, 200);
      assert.deepEqual(missing.body.data.map((row: BoardRow) => row.spruceOrderId), [D.noPhone]);
    });
  });

  // ---------------------------------------------------------------- A9-A11

  describe('A9-A11: invoices come to the app by email: ap@ forwards them, senders come from the supplier records', () => {
    it('A9/A10: an invoice ap@ forwards is filed under the supplier who sent it, not under ap@', async () => {
      // Microsoft 365's forwarding rule (A10) is outside the app: this is the
      // message as Gmail receives it from ap@, with the supplier's original
      // headers in the body and ap@'s domain passing DKIM/SPF.
      paversMessage = deliverMail({
        from: `Accounts Payable <${FORWARDER}>`,
        headers: { 'Authentication-Results': AUTH_PASS },
        subject: 'FW: Invoice PP-5001',
        text: `FYI\n\n-----Original Message-----\nFrom: Pavers Billing <${PAVERS_BILLING}>\nSent: Monday\nSubject: Invoice PP-5001\n`,
        attachments: [
          { filename: 'PP-5001.pdf', mimeType: PDF_TYPE, content: await pdf('Invoice PP-5001') },
          // A15: the supplier attached its copies of two tickets.
          { filename: 'ticket-PP-55001.png', mimeType: 'image/png', content: ticketPhoto },
          { filename: 'ticket-PP-55002.png', mimeType: 'image/png', content: ticketPhoto },
        ],
      });
      await poll();

      const event = await prisma.emailIngestionEvent.findUniqueOrThrow({ where: { gmailMessageId: paversMessage } });
      assert.equal(event.status, 'PROCESSED', event.errorMessage ?? '');
      assert.equal(event.senderMode, 'forward');
      assert.equal(event.originalFrom, PAVERS_BILLING);
      assert.equal(event.forwardedBy, FORWARDER);
      assert.equal(event.supplierId, suppliers.pavers);

      const invoice = await prisma.invoice.findFirstOrThrow({ where: { gmailMessageId: { startsWith: `${paversMessage}:` } } });
      paversInvoiceId = invoice.id;
      assert.equal(invoice.supplierId, suppliers.pavers);
      assert.equal(invoice.emailFrom, PAVERS_BILLING, 'the supplier, never the AP mailbox');
      assert.deepEqual(event.createdInvoiceIds, [invoice.id]);
      // The PDF itself was stored where the invoice points, and its reading queued.
      const marker = `/object/public/${env.supabaseStorageBucket}/`;
      const key = decodeURIComponent(new URL(invoice.fileUrl).pathname.split(marker)[1] ?? '');
      assert.equal(stored.get(key)?.subarray(0, 4).toString('ascii'), '%PDF');
      assert.equal(queuedOcr.length, 1);

      // A15: the ticket pages became the supplier's copies, under the supplier.
      const emailed = await prisma.ticket.findMany({ where: { source: 'EMAIL' } });
      assert.equal(emailed.length, 2);
      assert.ok(emailed.every(ticket => ticket.supplierId === suppliers.pavers));
      assert.ok(labelsOf(paversMessage).includes('cgc-processed'));
    });

    it('A11: a sender no supplier record knows waits in the review queue; nothing is downloaded or filed', async () => {
      unknownMessage = deliverMail({
        from: 'Quarry Billing <accounts@unknown-quarry.test>',
        subject: 'Invoice UQ-1',
        attachments: [{ filename: 'UQ-1.pdf', mimeType: PDF_TYPE, content: await pdf('Invoice UQ-1') }],
      });
      await poll();

      const event = await prisma.emailIngestionEvent.findUniqueOrThrow({ where: { gmailMessageId: unknownMessage } });
      assert.equal(event.status, 'NEEDS_REVIEW');
      assert.equal(event.reviewReason, 'UNKNOWN_SENDER');
      assert.deepEqual(event.createdInvoiceIds, []);
      assert.ok(!mailbox.downloads.some(key => key.startsWith(`${unknownMessage}:`)), 'nothing downloaded');
      assert.equal(await prisma.invoice.count({ where: { gmailMessageId: { startsWith: `${unknownMessage}:` } } }), 0);
      assert.ok(labelsOf(unknownMessage).includes('cgc-review'));

      const queue = await api('GET', '/api/email-events', undefined, 'AP_USER');
      assert.equal(queue.status, 200, 'the AP desk may look');
      assert.ok(queue.body.events.some((row: { id: string }) => row.id === event.id));
    });

    it('A11: approving a sender edits a supplier, so the AP desk may not (403)', async () => {
      const event = await prisma.emailIngestionEvent.findUniqueOrThrow({ where: { gmailMessageId: unknownMessage } });
      const refused = await api('POST', `/api/email-events/${event.id}/approve`, { supplierId: suppliers.aggregates }, 'AP_USER');
      assert.equal(refused.status, 403);
      const aggregates = await prisma.supplier.findUniqueOrThrow({ where: { id: suppliers.aggregates } });
      assert.deepEqual(aggregates.emailAddresses, []);
    });

    it('A11: an owner approves it onto a supplier; the waiting email is re-queued and read on the next poll', async () => {
      const event = await prisma.emailIngestionEvent.findUniqueOrThrow({ where: { gmailMessageId: unknownMessage } });
      const approved = await api('POST', `/api/email-events/${event.id}/approve`, { supplierId: suppliers.aggregates, match: 'address' }, 'OWNER');
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal(approved.body.requeued, 1);
      assert.deepEqual((await prisma.supplier.findUniqueOrThrow({ where: { id: suppliers.aggregates } })).emailAddresses, ['accounts@unknown-quarry.test']);

      await poll();
      const read = await prisma.emailIngestionEvent.findUniqueOrThrow({ where: { gmailMessageId: unknownMessage } });
      assert.equal(read.status, 'PROCESSED');
      assert.equal(read.requeuedAt, null);
      assert.equal(read.reviewedById, userIds.OWNER, 'who approved it stays on record');
      const invoice = await prisma.invoice.findFirstOrThrow({ where: { gmailMessageId: { startsWith: `${unknownMessage}:` } } });
      assert.equal(invoice.supplierId, suppliers.aggregates);
      assert.ok(labelsOf(unknownMessage).includes('cgc-processed'));
    });

    it('A9: observe mode only records who sent what: no invoice and nothing downloaded', async () => {
      const id = deliverMail({
        from: 'Stone Accounts <accounts@fictional-stone.test>',
        subject: 'Invoice FS-1999',
        attachments: [{ filename: 'FS-1999.pdf', mimeType: PDF_TYPE, content: await pdf('Invoice FS-1999') }],
      });
      const invoices = await prisma.invoice.count();
      await poll({ GMAIL_INGEST_MODE: 'observe' });

      assert.equal(await prisma.invoice.count(), invoices);
      assert.ok(!mailbox.downloads.some(key => key.startsWith(`${id}:`)));
      const event = await prisma.emailIngestionEvent.findUniqueOrThrow({ where: { gmailMessageId: id } });
      assert.equal(event.originalFrom, 'accounts@fictional-stone.test');
      assert.ok(labelsOf(id).includes('cgc-observed'));
      assert.ok(labelsOf(id).includes('UNREAD'), 'left for ingest mode');
      // Ingest mode would read it next; for this day it is taken out of the
      // inbox so the polls below see only their own mail.
      mailbox.messages = mailbox.messages.filter(message => message.id !== id);
    });
  });

  // ---------------------------------------------------------------- A12

  describe('A12: invoices come as PDF attachments, a few as Excel', () => {
    it('A12: an .xlsx invoice is read as text by the same invoice reader', async () => {
      const book = new ExcelJS.Workbook();
      const sheet = book.addWorksheet('Invoice');
      sheet.addRow(['Fictional Stoneworks Ltd.', 'Invoice', 'FS-2001']);
      sheet.addRow(['Item', 'Qty', 'Unit', 'Price', 'Total']);
      sheet.addRow(['Fictional Patio Slab 24x24', 40, 'EA', 18, 720]);
      const id = deliverMail({
        from: 'Stone Accounts <accounts@fictional-stone.test>',
        subject: 'Invoice FS-2001',
        attachments: [{ filename: 'FS-2001.xlsx', mimeType: XLSX_TYPE, content: Buffer.from(await book.xlsx.writeBuffer()) }],
      });
      await poll();

      const invoice = await prisma.invoice.findFirstOrThrow({ where: { gmailMessageId: { startsWith: `${id}:` } } });
      assert.equal(invoice.supplierId, suppliers.stone);
      assert.match(invoice.fileUrl, /\.xlsx$/);
      // Even sorting its pages read it as text.
      assert.ok(asked.some(entry => entry.schemaName === 'attachment_triage' && entry.text?.includes('FS-2001')));

      await runOcr(await ocrJobOfInvoice(invoice.id), {
        invoice: invoiceReading('Fictional Stoneworks Ltd.', 'FS-2001', [
          { description: 'Fictional Patio Slab 24x24', quantity: 40, unit: 'EA', unitPrice: 18, poNumber: po(D.fobCollects) },
        ]),
      });
      const reading = asked.filter(entry => entry.schemaName === 'supplier_invoice').at(-1)!;
      assert.match(reading.text ?? '', /# Sheet: Invoice/);
      assert.match(reading.text ?? '', /Fictional Patio Slab 24x24\t40\tEA\t18\t720/);
      const read = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id }, include: { lineItems: true } });
      assert.equal(read.invoiceNumber, 'FS-2001');
      assert.equal(read.lineItems.length, 1);
    });

    it('A12: an old .xls goes to a person, asking for a PDF or .xlsx', async () => {
      const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(2048)]);
      const id = deliverMail({
        from: 'Stone Accounts <accounts@fictional-stone.test>',
        subject: 'Invoice FS-1998',
        attachments: [{ filename: 'FS-1998.xls', mimeType: 'application/vnd.ms-excel', content: ole }],
      });
      await poll();
      const event = await prisma.emailIngestionEvent.findUniqueOrThrow({ where: { gmailMessageId: id } });
      assert.equal(event.status, 'NEEDS_REVIEW');
      assert.equal(event.reviewReason, 'SPREADSHEET');
      assert.match(JSON.stringify(event.attachments), /old Excel format \(\.xls\)/);
      assert.equal(await prisma.invoice.count({ where: { gmailMessageId: { startsWith: `${id}:` } } }), 0);
    });

    it('A12: an Excel beside a PDF invoice is kept with it as a supporting file, never billed twice', async () => {
      const book = new ExcelJS.Workbook();
      book.addWorksheet('Loads').addRow(['Ticket', 'Net']);
      const asking = asked.length;
      const id = deliverMail({
        from: 'Stone Accounts <accounts@fictional-stone.test>',
        subject: 'Invoice FS-2002',
        attachments: [
          { filename: 'FS-2002.pdf', mimeType: PDF_TYPE, content: await pdf('Invoice FS-2002') },
          { filename: 'FS-2002-loads.xlsx', mimeType: XLSX_TYPE, content: Buffer.from(await book.xlsx.writeBuffer()) },
        ],
      });
      await poll();
      const invoices = await prisma.invoice.findMany({ where: { gmailMessageId: { startsWith: `${id}:` } }, include: { supportingFiles: true } });
      assert.equal(invoices.length, 1, 'one invoice from the email');
      assert.deepEqual(invoices[0]!.supportingFiles.map(file => [file.originalName, file.contentType]), [['FS-2002-loads.xlsx', XLSX_TYPE]]);
      assert.ok(!asked.slice(asking).some(entry => /loads\.xlsx/.test(entry.filename)), 'the breakdown is not read as an invoice');
    });
  });

  // ---------------------------------------------------------------- A13

  describe('A13: the client sends sample invoices', () => {
    it('A13: the sample dry run, in fixture mode, reads and matches them and writes nothing', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'cgc-acceptance-samples-'));
      const examples = path.join(here, '..', 'docs', 'invoice-samples');
      try {
        writeFileSync(path.join(dir, 'example.csv'), 'Item,Qty,Unit,Price,Total\nTest Clear Stone 19mm,30,t,31.50,945.00\n');
        writeFileSync(path.join(dir, 'example.csv.extraction.json'), JSON.stringify({
          invoice: {
            supplierName: 'Example Aggregates Ltd.', invoiceNumber: 'INV-55001', date: '2026-10-22', poNumber: '2610-900101',
            totalAmount: 1067.85, readability: 'clear', uncertainFields: [],
            lineItems: [{ description: 'Test Clear Stone 19mm', quantity: 30, unit: 't', unitPrice: 31.5, totalPrice: 945, poNumber: null }],
          },
        }));
        writeFileSync(path.join(dir, 'related.json'), readFileSync(path.join(examples, 'related.example.json')));

        const before = await rowCounts();
        const files = stored.size;
        const extraction = await import('../src/services/extraction/extraction.service.js');
        const { runSampleDryRun } = await import('../src/scripts/invoiceSampleDryRun.js');
        const report = await runSampleDryRun(
          { dir, mode: 'fixture', saveExtractions: false, related: { kind: 'auto' }, only: [], writeReport: false },
          { extraction }
        );
        assert.equal(report.writes, 'none');
        assert.equal(report.summary.invoicesRead, 1);
        assert.equal(report.samples[0]!.matching?.lines[0]?.status, 'MATCHED');
        assert.deepEqual(await rowCounts(), before, 'not a row written');
        assert.equal(stored.size, files, 'nothing stored');
        assert.equal(extraction.activeProvider().name, standIn.name, 'the reader is put back');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------- A14

  describe('A14: price lists for material suppliers; a haul rate on every dispatch load', () => {
    it('A14: a price list is previewed, then saved all at once', async () => {
      const from = addDays(today, -30);
      const csv = Buffer.from([
        'product,spruce_item_code,supplier_item_code,unit,rate,effective_from,effective_to,notes',
        `Charcoal Paver 60mm (price list),PLCCHAR60,PP-60-CH,SQFT,4.10,${from},,`,
        `Polymeric Sand Grey,PLCSAND,PP-PS-GR,EA,28.50,${from},,`,
      ].join('\n'));
      const file = { bytes: csv, name: 'pavers-prices.csv' };
      const preview = await apiUpload(`/api/suppliers/${suppliers.pavers}/rates/import/preview`, file, {}, 'AP_USER');
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      assert.equal(preview.body.plan.counts.CREATE, 2);
      assert.equal(preview.body.plan.canCommit, true);
      assert.equal(await prisma.negotiatedRate.count(), 0, 'a preview writes nothing');

      const saved = await apiUpload(`/api/suppliers/${suppliers.pavers}/rates/import`, file, { token: preview.body.token }, 'AP_USER');
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      await waitForRateRechecks();
      const rates = await prisma.negotiatedRate.findMany({ orderBy: { productName: 'asc' } });
      assert.deepEqual(rates.map(rate => [rate.spruceItemCode, Number(rate.rate)]), [['PLCCHAR60', 4.1], ['PLCSAND', 28.5]]);
    });

    it('A14: a material invoice line finds its agreed rate by the Spruce item code', async () => {
      await runOcr(await ocrJobOfInvoice(paversInvoiceId), {
        invoice: invoiceReading('Placeholder Pavers Inc.', 'PP-5001', [
          { description: CHARCOAL, quantity: 300, unit: 'SQFT', unitPrice: 4.1, poNumber: po(D.poDelivery) },
          { description: POLY_SAND, quantity: 6, unit: 'EA', unitPrice: 28.5, poNumber: po(D.poDelivery) },
        ]),
      });
      const [charcoal] = await lineVerdicts(paversInvoiceId);
      // The price list words it "Charcoal Paver 60mm (price list)"; the order line's code finds it.
      assert.match(JSON.stringify(charcoal!.matchResult!.evidence), /found by item code PLCCHAR60/);
      assert.equal(Number(charcoal!.negotiatedRate), 4.1);
      assert.equal(Number(charcoal!.approvedTotal), 1230);
      const orderLine = await prisma.order.findFirstOrThrow({ where: { document: { documentNumber: D.poDelivery }, spruceItemNumber: 'PLCCHAR60' } });
      assert.equal(charcoal!.matchedOrderId, orderLine.id);
    });

    it('A14: dispatch sets a haul rate per load: one rate for both loads of the trip, and one load left unpriced', async () => {
      const tripLoad = await prisma.dispatchLoad.findFirstOrThrow({ where: { document: { documentNumber: D.tripA } } });
      const copied = await api('POST', `/api/dispatch/loads/${tripLoad.id}/copy-rate-to-trip`);
      assert.equal(copied.status, 200, JSON.stringify(copied.body));
      assert.equal(copied.body.updated, 1);
      const trip = await prisma.dispatchLoad.findMany({ where: { tripRef: 'ACC-TRIP-1' } });
      assert.deepEqual(trip.map(load => [Number(load.rate), load.rateUnit]), [[150, 'LOAD'], [150, 'LOAD']]);

      const priced = await api('POST', `/api/dispatch/orders/${await idOf(D.pitOverPo)}/loads`, {
        carrierSupplierId: suppliers.haulage, rate: '200', rateUnit: 'LOAD', quantity: '1', ticketNumber: 'HH-T2',
      });
      assert.equal(priced.status, 201, JSON.stringify(priced.body));
      const unpriced = await api('POST', `/api/dispatch/orders/${await idOf(D.pitBlk)}/loads`, {
        carrierSupplierId: suppliers.haulage, quantity: '1', ticketNumber: 'HH-T3',
      });
      assert.equal(unpriced.status, 201, JSON.stringify(unpriced.body));
      assert.equal(unpriced.body.rate, null);
      assert.equal(unpriced.body.sourceSupplierId, suppliers.pit, 'the pit dispatch chose (A5)');
      unpricedLoadId = unpriced.body.id;
    });

    it('A14: a trucking invoice is checked line by line against those loads and their rates', async () => {
      const id = deliverMail({
        from: 'Haulage Dispatch <dispatch@hypothetical-haulage.test>',
        subject: 'Invoice HH-7001',
        attachments: [{ filename: 'HH-7001.pdf', mimeType: PDF_TYPE, content: await pdf('Invoice HH-7001') }],
      });
      await poll();
      const invoice = await prisma.invoice.findFirstOrThrow({ where: { gmailMessageId: { startsWith: `${id}:` } } });
      haulInvoiceId = invoice.id;
      assert.equal(invoice.senderType, 'TRUCKING_COMPANY');
      await runOcr(await ocrJobOfInvoice(invoice.id), {
        invoice: invoiceReading('Hypothetical Haulage Ltd.', 'HH-7001', [
          // The whole trip on one line: its two loads at $150 a load. It quotes
          // the first load's ticket, but bills the trip's quantity, not that load's.
          { description: 'Tri-axle haul, 2 POs one trip', quantity: 2, unit: 'load', unitPrice: 150, ticketNumber: 'HH-T1', serviceDate: today },
          // 5% above the $200 dispatch agreed.
          { description: 'Tri-axle haul', quantity: 1, unit: 'load', unitPrice: 210, ticketNumber: 'HH-T2', serviceDate: today },
          { description: 'Tri-axle haul', quantity: 1, unit: 'load', unitPrice: 180, ticketNumber: 'HH-T3', serviceDate: today },
        ]),
      });

      const [trip, over, unpriced] = await lineVerdicts(invoice.id);
      assert.equal(trip!.ticketNumber, 'HH-T1');
      assert.equal(trip!.serviceDate?.toISOString().slice(0, 10), today);
      assert.equal(trip!.matchResult!.status, 'MATCHED', trip!.matchResult!.reason);
      assert.equal(trip!.matchResult!.loadIds.length, 2, 'the trip is one haul over two orders');
      assert.equal(Number(trip!.approvedTotal), 300, 'rate x quantity');

      assert.equal(check(over!.matchResult, 'haulRate')?.code, 'RATE_MISMATCH');
      assert.equal(over!.flag, 'RATE_MISMATCH');
      assert.equal(Number(over!.negotiatedRate), 200);
      assert.equal(Number(over!.approvedTotal), 200);

      assert.equal(check(unpriced!.matchResult, 'haulRate')?.code, 'NO_RATE_SET');
      assert.equal(unpriced!.matchResult!.status, 'PARTIAL', 'for AP to review');
      assert.equal(await prisma.dispatchLoad.count({ where: { claimedByLineItemId: { not: null } } }), 0, 'nothing paid yet');
    });

    it('A14: verifying waits until every finding is settled, then claims the loads it pays', async () => {
      assert.equal((await api('POST', `/api/invoices/${haulInvoiceId}/verify`)).status, 409);

      // Dispatch fills in the missing rate: the waiting line is checked again by itself.
      const rated = await api('PATCH', `/api/dispatch/loads/${unpricedLoadId}`, { rate: '180', rateUnit: 'LOAD' });
      assert.equal(rated.status, 200, JSON.stringify(rated.body));
      const [, over, unpriced] = await lineVerdicts(haulInvoiceId);
      assert.equal(unpriced!.matchResult!.status, 'MATCHED', unpriced!.matchResult!.reason);

      // AP pays the over-billed line at the rate dispatch agreed.
      const settled = await api('POST', `/api/matching/results/${over!.matchResult!.id}/resolve`, {
        resolution: 'CONFIRMED', note: 'Paying the $200 dispatch agreed; carrier told.',
      });
      assert.equal(settled.status, 200, JSON.stringify(settled.body));

      const verified = await api('POST', `/api/invoices/${haulInvoiceId}/verify`);
      assert.equal(verified.status, 200, JSON.stringify(verified.body));
      assert.equal(verified.body.status, 'VERIFIED');
      const lines = await lineVerdicts(haulInvoiceId);
      const claimed = await prisma.dispatchLoad.findMany({ where: { claimedByLineItemId: { not: null } } });
      assert.equal(claimed.length, 4, 'both trip loads, the $200 load and the one priced since');
      assert.deepEqual(
        [...new Set(claimed.map(load => load.claimedByLineItemId))].sort(),
        lines.map(line => line.id).sort()
      );
    });

    it('A14: a second invoice for a load already paid is LOAD_ALREADY_CLAIMED', async () => {
      const id = deliverMail({
        from: 'Haulage Dispatch <dispatch@hypothetical-haulage.test>',
        subject: 'Invoice HH-7002',
        attachments: [{ filename: 'HH-7002.pdf', mimeType: PDF_TYPE, content: await pdf('Invoice HH-7002') }],
      });
      await poll();
      const invoice = await prisma.invoice.findFirstOrThrow({ where: { gmailMessageId: { startsWith: `${id}:` } } });
      await runOcr(await ocrJobOfInvoice(invoice.id), {
        invoice: invoiceReading('Hypothetical Haulage Ltd.', 'HH-7002', [
          { description: 'Tri-axle haul', quantity: 1, unit: 'load', unitPrice: 150, ticketNumber: 'HH-T1', serviceDate: today },
        ]),
      });
      const [repeat] = await lineVerdicts(invoice.id);
      assert.equal(check(repeat!.matchResult, 'loadReuse')?.code, 'LOAD_ALREADY_CLAIMED');
      assert.match(check(repeat!.matchResult, 'loadReuse')!.detail, /already paid on invoice HH-7001 line 1/);
      assert.equal(repeat!.matchResult!.status, 'PARTIAL');
    });
  });

  // ---------------------------------------------------------------- A15

  describe('A15: some suppliers attach tickets to the invoice; most tickets come from drivers', () => {
    const emailedCopy = (part: number) =>
      prisma.ticket.findFirstOrThrow({ where: { source: 'EMAIL', emailSourceKey: { startsWith: `${paversMessage}:${part}` } } });

    it('A15: a line backed only by the supplier\'s own emailed ticket is held for AP review', async () => {
      const sand = await emailedCopy(3);
      await runOcr(await ocrJobOfTicket(sand.id), { ticket: ticketReading('PP-55002', POLY_SAND, 6, 'EA') });
      const [, sandLine] = await lineVerdicts(paversInvoiceId);
      assert.equal(check(sandLine!.matchResult, 'billerTicketsOnly')?.passed, false);
      assert.notEqual(sandLine!.matchResult!.status, 'MATCHED', 'never passed on the biller\'s word alone');
    });

    it('A15: the driver\'s photo and the emailed page of one ticket are one load, counted once', async () => {
      const stop = await currentStop('DRIVER_2');
      assert.equal(stop.document.documentNumber, D.poDelivery);
      const uploaded = await apiUpload(`/api/deliveries/${stop.id}/photos`, { bytes: ticketPhoto, name: 'pp-55001.png', type: 'image/png' }, { type: 'ticket' }, 'DRIVER_2');
      assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
      assertNoMoney(uploaded.body, 'the photo upload\'s answer');

      const photo = await prisma.ticket.findFirstOrThrow({ where: { source: 'MANUAL', driverId: drivers.drew } });
      await runOcr(await ocrJobOfTicket(photo.id), { ticket: ticketReading('PP 55001', CHARCOAL, 300, 'SQFT') });
      const charcoal = await emailedCopy(2);
      await runOcr(await ocrJobOfTicket(charcoal.id), { ticket: ticketReading('PP-55001', CHARCOAL, 300, 'SQFT') });

      const copy = await prisma.ticket.findUniqueOrThrow({ where: { id: charcoal.id } });
      assert.equal(copy.duplicateOfTicketId, photo.id, 'the driver\'s copy is the one that counts');
      const [line] = await lineVerdicts(paversInvoiceId);
      assert.equal(check(line!.matchResult, 'ticketCoverage')?.found, 300, '300 SQFT, not 600');
      assert.deepEqual(line!.matchResult!.ticketIds, [photo.id]);
      assert.equal(check(line!.matchResult, 'copiesAgree')?.passed, true);
      assert.equal(line!.matchResult!.status, 'MATCHED', line!.matchResult!.reason);
    });
  });

  // ---------------------------------------------------------------- throughout

  describe('Throughout: drivers never see prices, rates or supplier money', () => {
    it('every driver\'s phone, run and profile carry none, and the office\'s routes refuse them', async () => {
      const own = { DRIVER_1: drivers.dana, DRIVER_2: drivers.drew, DRIVER_3: drivers.devon } as const;
      for (const [role, driverId] of Object.entries(own) as Array<[Role, string]>) {
        await currentStop(role);
        const run = await api('GET', `/api/drivers/${driverId}/deliveries`, undefined, role);
        assert.equal(run.status, 200);
        assertNoMoney(run.body, `${role}'s run`);
        const me = await api('GET', '/api/drivers/me', undefined, role);
        assert.equal(me.status, 200);
        assertNoMoney(me.body, `${role}'s profile`);
      }
      // Devon's stop has a haul load with a rate on it now (A14): still not on the phone.
      assert.ok(await prisma.dispatchLoad.count({ where: { document: { documentNumber: D.pitBlk }, rate: { not: null } } }));

      const office = [
        '/api/dispatch', `/api/dispatch/orders/${await idOf(D.pitBlk)}/loads`, '/api/invoices', '/api/email-events',
        '/api/orders/documents', `/api/suppliers/${suppliers.pavers}/rates/import/preview`,
      ];
      for (const route of office) {
        const method = route.endsWith('/preview') ? 'POST' : 'GET';
        assert.equal((await api(method, route, undefined, 'DRIVER_1')).status, 403, `${method} ${route}`);
      }
    });
  });
});
