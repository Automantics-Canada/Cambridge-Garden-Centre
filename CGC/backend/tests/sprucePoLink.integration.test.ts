// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/prisma.js';
import { runImportBatch, type BatchFile } from '../src/modules/orders/import/importBatch.service.js';
import type {
  ParsedSpruceReport,
  ParsedSpruceRow,
  SpruceReportType,
} from '../src/modules/orders/spruce/spruceReportTypes.js';
import {
  matchInvoiceById,
  matchTicketById,
  recomputeForPoNumbers,
} from '../src/modules/matching/matching.service.js';
import { aug14SpruceReports } from './fixtures/aug14SpruceShapes.js';

/**
 * A delivery ticket and a supplier invoice link to a Spruce order by its PO.
 *
 * The manager's original ask, and the acceptance run's "PO link: FAIL": a
 * Spruce PO is printed `2608-355356`, the engine accepted only six digits, and
 * square feet were not a unit it knew — so a ticket for 629.46 SQFT of pavers
 * on that PO matched nothing, and the invoice for it was paired only by the
 * supplier/date/product fallback, which never links a ticket.
 *
 * The orders come through the real morning import, from the 8/14-shaped
 * synthetic reports, with one document given the shape of 712595 on the
 * sample day: two paver lines in square feet and the skid deposits, all on one
 * Unilock PO raised under vendor code UNILOCKL01. Customer, address and the
 * other documents stay synthetic.
 *
 *   CGC_TEST_CONFIRM_DISPOSABLE=1 node scripts/run-tests.mjs integration
 */

const confirmed = process.env.CGC_TEST_CONFIRM_DISPOSABLE === '1';
const loopback = (() => {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
})();
const runnable = confirmed && loopback;

const SPRUCE_PO = '2608-355356';
const DOCUMENT = '2608-712595';
const FOSSIL = 'BeaconHill Smooth 60mm Fossil';
const MIDNIGHT = 'BeaconHill Smooth 60mm Midnight';

/** The synthetic document standing in for 712595: SQFT pavers on one vendor PO. */
const SHAPED_DOCUMENT = '9900-000004';

/** Product token → what the 712595 line printed. */
const LINES: Record<string, { product: string; itemNumber: string; quantity?: number }> = {
  'Synthetic Product P11': { product: MIDNIGHT, itemNumber: 'BHS6CSR', quantity: 104.91 },
  'Synthetic Product P13': { product: FOSSIL, itemNumber: 'BHS6F', quantity: 629.46 },
  'Synthetic Product P12': { product: 'Unilock Skid Deposit', itemNumber: 'USKID' },
  'Synthetic Product P14': { product: 'Delivery Charge', itemNumber: 'MISCDEL' },
  'Synthetic Product P15': { product: '**Special Order, Purchase and Returns in full skids only**', itemNumber: 'COMMENT' },
};

/**
 * The synthetic fixture's days, moved onto the sample week: the delivery
 * report's day becomes 8/14, and the 712595-shaped order goes out on 8/17.
 */
const DAYS: Record<string, string> = {
  '09/01/2026': '08/17/2026',
  '09/02/2026': '08/14/2026',
  '09/03/2026': '08/19/2026',
  '09/04/2026': '08/31/2026',
};

function shapeRow(row: ParsedSpruceRow): ParsedSpruceRow {
  const moved: ParsedSpruceRow = {
    ...row,
    ...(row.deliveryDateRaw ? { deliveryDateRaw: DAYS[row.deliveryDateRaw] ?? row.deliveryDateRaw } : {}),
  };
  if (row.documentNumber !== SHAPED_DOCUMENT) return moved;

  const line = LINES[row.product];
  return {
    ...moved,
    documentNumber: DOCUMENT,
    ...(line
      ? { product: line.product, itemNumber: line.itemNumber, ...(line.quantity ? { quantity: line.quantity } : {}) }
      : {}),
    ...(row.poNumber ? { poNumber: SPRUCE_PO } : {}),
    ...(row.vendorName ? { vendorName: 'UNILOCKL01' } : {}),
  };
}

function reports(): Record<SpruceReportType, ParsedSpruceReport> {
  const base = aug14SpruceReports();
  return {
    ORDER_SUMMARY: { ...base.ORDER_SUMMARY, rows: base.ORDER_SUMMARY.rows.map(shapeRow) },
    ITEM_TRACKING: { ...base.ITEM_TRACKING, rows: base.ITEM_TRACKING.rows.map(shapeRow) },
    DELIVERY: { ...base.DELIVERY, rows: base.DELIVERY.rows.map(shapeRow) },
  };
}

function files(): BatchFile[] {
  const parsed = reports();
  return (Object.keys(parsed) as SpruceReportType[]).map((reportType) => ({
    reportType,
    fileName: `${reportType}.pdf`,
    buffer: Buffer.from(`po-link-${reportType}`),
    report: parsed[reportType],
  }));
}

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "MatchResult", "TicketClaim", "TicketOrderMatch", "InvoiceLineItem", "Invoice", ' +
      '"Ticket", "Order", "OrderDocument", "ImportBatch", "SpruceImportJob", "NegotiatedRate", ' +
      '"SupplierProductAlias", "SupplierSpruceVendor", "Supplier", "User", "SystemSetting" ' +
      'RESTART IDENTITY CASCADE'
  );
}

let supplierId = '';
let userId = '';

async function createTicket(poNumber: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const ticket = await prisma.ticket.create({
    data: {
      source: 'MANUAL',
      supplierId,
      supplierName: 'Unilock',
      ticketNumber: `U-${poNumber}`,
      poNumber,
      material: FOSSIL,
      quantity: 629.46,
      unit: 'SQFT',
      ticketDate: new Date('2026-08-14'),
      imageUrl: '/uploads/none.png',
      ocrRawText: '',
      ocrConfidence: 0.95,
      status: 'UNLINKED',
      ...overrides,
    },
    select: { id: true },
  });
  return ticket.id;
}

async function fossilLineId(): Promise<string> {
  const document = await prisma.orderDocument.findUniqueOrThrow({
    where: { documentNumber: DOCUMENT },
    include: { lines: true },
  });
  const line = document.lines.find((entry) => entry.product === FOSSIL);
  assert.ok(line, 'the Fossil line was imported');
  return line.id;
}

describe('Spruce PO link (PostgreSQL)', { skip: !runnable }, () => {
  before(async () => {
    await reset();
    const user = await prisma.user.create({
      data: { name: 'Desk', email: 'desk@example.invalid', passwordHash: 'x', role: 'ADMIN' },
    });
    userId = user.id;
    const supplier = await prisma.supplier.create({
      data: { name: 'Unilock', type: 'SUPPLIER', emailDomains: [] },
    });
    supplierId = supplier.id;
    // What `npm run vendors:add -- UNILOCKL01 "Unilock"` records.
    await prisma.supplierSpruceVendor.create({ data: { code: 'UNILOCKL01', supplierId } });
    await prisma.negotiatedRate.create({
      data: {
        supplierId,
        productName: FOSSIL,
        rate: 4.1,
        unit: 'SQFT',
        effectiveFrom: new Date('2026-01-01'),
        createdById: userId,
      },
    });
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it('imports 712595 with its PO, vendor and square feet on every PO line', async () => {
    const summary = await runImportBatch(prisma, {
      dispatchDate: '2026-08-14',
      createdById: userId,
      files: files(),
    });
    assert.equal(summary.alreadyImported, false);

    const document = await prisma.orderDocument.findUniqueOrThrow({
      where: { documentNumber: DOCUMENT },
      include: { lines: true },
    });
    assert.equal(document.deliveryDate?.toISOString().slice(0, 10), '2026-08-17');
    const onPo = document.lines.filter((line) => line.poNumber === SPRUCE_PO);
    assert.ok(onPo.length >= 3, 'several lines share the one supplier PO');
    assert.ok(onPo.every((line) => line.supplierId === supplierId), 'UNILOCKL01 resolved to Unilock');

    const fossil = document.lines.find((line) => line.product === FOSSIL);
    assert.equal(fossil?.unit, 'SQFT');
    assert.equal(fossil?.quantity?.toString(), '629.46');
    assert.equal(fossil?.orderDate?.toISOString().slice(0, 10), '2026-08-14');
  });

  it('links a ticket on 2608-355356 to the Fossil line: LINKED, not PARTIAL', async () => {
    const ticketId = await createTicket(SPRUCE_PO);
    const decision = await matchTicketById(ticketId);
    const lineId = await fossilLineId();

    assert.equal(decision?.status, 'MATCHED', decision?.reason);
    assert.equal(decision?.orderId, lineId);

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    assert.equal(ticket.status, 'LINKED');
    assert.equal(ticket.linkedOrderId, lineId);
    assert.equal(ticket.linkMethod, 'AUTO');

    const stored = await prisma.matchResult.findFirstOrThrow({ where: { ticketId } });
    assert.equal(stored.status, 'MATCHED');
    const evidence = stored.evidence as Array<{ name: string; passed: boolean }>;
    for (const name of ['po', 'product', 'quantity', 'date']) {
      assert.equal(evidence.find((check) => check.name === name)?.passed, true, name);
    }

    const links = await prisma.ticketOrderMatch.findMany({ where: { ticketId } });
    assert.deepEqual(links.map((link) => link.orderId), [lineId]);
  });

  it('matches an invoice line on 2608-355356 to the same line, covered by that ticket', async () => {
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: 'UNI-0814',
        senderType: 'SUPPLIER',
        supplierId,
        invoiceDate: new Date('2026-08-14'),
        totalAmount: 2580.79,
        currency: 'CAD',
        fileUrl: '/uploads/none.pdf',
        emailFrom: 'ap@unilock.example',
        emailSubject: 'UNI-0814',
        gmailMessageId: 'po-link-uni-0814',
        ocrRawText: '',
        lineItems: {
          create: {
            lineNumber: 1,
            description: FOSSIL,
            poNumber: SPRUCE_PO,
            quantity: 629.46,
            unit: 'SQFT',
            unitRate: 4.1,
            lineTotal: 2580.79,
            flag: 'NO_ORDER',
          },
        },
      },
      select: { id: true },
    });

    const [decision] = await matchInvoiceById(invoice.id);
    const lineId = await fossilLineId();
    assert.equal(decision?.status, 'MATCHED', decision?.reason);
    assert.equal(decision?.orderId, lineId);

    const line = await prisma.invoiceLineItem.findFirstOrThrow({
      where: { invoiceId: invoice.id },
      include: { matchedTickets: { select: { poNumber: true } } },
    });
    assert.equal(line.matchedOrderId, lineId);
    assert.equal(line.flag, 'OK');
    assert.deepEqual(line.matchedTickets.map((ticket) => ticket.poNumber), [SPRUCE_PO]);
  });

  it('a ticket written as the bare six digits, or with a label, links to the same line', async () => {
    const lineId = await fossilLineId();
    for (const poNumber of ['355356', 'PO# 2608 355356']) {
      const ticketId = await createTicket(poNumber);
      await matchTicketById(ticketId);
      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
      assert.equal(ticket.status, 'LINKED', poNumber);
      assert.equal(ticket.linkedOrderId, lineId, poNumber);
    }
  });

  it('a ticket on another prefix with the same six digits is not linked', async () => {
    const ticketId = await createTicket('2607-355356');
    const decision = await matchTicketById(ticketId);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    assert.equal(ticket.status, 'UNLINKED');
    assert.equal(ticket.linkedOrderId, null);
    assert.equal(decision?.checks.find((check) => check.name === 'po')?.passed, false);
  });

  it('a Spruce recompute on 2608-355356 reaches a ticket stored as 355356', async () => {
    // The import names the PO as Spruce prints it; the yard's paper may not.
    const ticketId = await createTicket('355356', { ticketNumber: 'U-late' });
    await recomputeForPoNumbers([SPRUCE_PO]);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    assert.equal(ticket.status, 'LINKED');
    assert.equal(ticket.linkedOrderId, await fossilLineId());
  });
});
