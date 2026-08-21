import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { prisma } from '../src/db/prisma.js';
import { getPdfImportJob } from '../src/modules/orders/order.controller.js';
import { OrderPdfImportService } from '../src/modules/orders/orderPdfImport.service.js';
import {
  applyPoReportMerge,
  type PoReportLine,
  type PoReportRow,
} from '../src/modules/orders/poReportMerge.service.js';
import { parseSprucePages } from '../src/modules/orders/spruce/parseSprucePdf.js';
import {
  deliveryReport,
  itemTrackingReport,
  orderSummaryReport,
} from './fixtures/spruceLayouts.js';

const disposableConfirmed = process.env.SPRUCE_TEST_CONFIRM_DISPOSABLE === '1';

async function resetDatabase(): Promise<void> {
  if (!disposableConfirmed) {
    throw new Error('Refusing to clear a database without SPRUCE_TEST_CONFIRM_DISPOSABLE=1');
  }
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "OrderDocument", "Order", "Supplier", "User", "SpruceImportJob" ' +
      'RESTART IDENTITY CASCADE'
  );
}

async function seedSupplier(code = 'STONECO01') {
  const supplier = await prisma.supplier.create({
    data: {
      name: `Integration Supplier ${code}`,
      type: 'SUPPLIER',
      emailDomains: [],
      keywords: [],
    },
  });
  await prisma.supplierSpruceVendor.create({
    data: { code, supplierId: supplier.id },
  });
  return supplier;
}

const reports = {
  ORDER_SUMMARY: parseSprucePages(orderSummaryReport()),
  ITEM_TRACKING: parseSprucePages(itemTrackingReport()),
  DELIVERY: parseSprucePages(deliveryReport()),
};

const reportOrders = [
  ['ORDER_SUMMARY', 'ITEM_TRACKING', 'DELIVERY'],
  ['ORDER_SUMMARY', 'DELIVERY', 'ITEM_TRACKING'],
  ['ITEM_TRACKING', 'ORDER_SUMMARY', 'DELIVERY'],
  ['ITEM_TRACKING', 'DELIVERY', 'ORDER_SUMMARY'],
  ['DELIVERY', 'ORDER_SUMMARY', 'ITEM_TRACKING'],
  ['DELIVERY', 'ITEM_TRACKING', 'ORDER_SUMMARY'],
] as const;

describe('Spruce import PostgreSQL integration', { skip: !disposableConfirmed }, () => {
  beforeEach(resetDatabase);

  after(async () => {
    await prisma.$disconnect();
  });

  it('produces the same persisted line identities in every report order', async () => {
    let expected: string[] | undefined;

    for (const [permutationIndex, order] of reportOrders.entries()) {
      await resetDatabase();
      await seedSupplier();

      for (const [reportIndex, reportName] of order.entries()) {
        const summary = await OrderPdfImportService.applyReport(
          prisma,
          reports[reportName],
          `permutation-${permutationIndex}-${reportIndex}`
        );
        assert.equal(summary.conflicts, 0, `${order.join(' -> ')} must not conflict`);
        assert.equal(summary.skipped, 0, `${order.join(' -> ')} must not skip rows`);
      }

      const stored = await prisma.order.findMany({
        select: {
          id: true,
          spruceOrderId: true,
          spruceItemNumber: true,
          product: true,
          quantity: true,
          document: { select: { documentNumber: true } },
        },
        orderBy: [{ spruceOrderId: 'asc' }],
      });
      const signature = stored.map(line => [
        line.document?.documentNumber,
        line.spruceItemNumber,
        line.product,
        line.quantity?.toString(),
      ].join('|')).sort();

      if (!expected) expected = signature;
      else assert.deepEqual(signature, expected, order.join(' -> '));
      assert.equal(new Set(stored.map(line => line.id)).size, stored.length);
    }
  });

  it('adopts a Textract-era row without moving any operational relationship', async () => {
    const supplier = await seedSupplier('LEGACY01');
    const user = await prisma.user.create({
      data: {
        name: 'Integration User',
        email: 'integration@example.invalid',
        passwordHash: 'not-a-real-password-hash',
        role: 'AP_USER',
      },
    });
    const driver = await prisma.driver.create({
      data: { name: 'Integration Driver', phone: '+15550000001' },
    });
    const legacy = await prisma.order.create({
      data: {
        spruceOrderId: '2608-700001-P1-T1-2',
        product: 'Garden Soil Bulk',
        quantity: '3',
        unit: 'CY',
        customerName: 'Riverbend Landscaping',
        buyerType: 'RETAIL',
        supplierId: supplier.id,
        poNumber: 'LEGACY-PO',
        orderDate: new Date('2026-09-02'),
        hasInvoice: true,
        invoiceNumber: 'INV-LEGACY',
        driverId: driver.id,
        deliveryStatus: 'IN_TRANSIT',
        priority: 9,
      },
    });
    const delivery = await prisma.delivery.create({
      data: { orderId: legacy.id, driverId: driver.id, status: 'IN_TRANSIT' },
    });
    const ticket = await prisma.ticket.create({
      data: {
        ticketNumber: 'T-LEGACY',
        source: 'MANUAL',
        supplierId: supplier.id,
        imageUrl: 'https://example.invalid/ticket.jpg',
        ocrRawText: '',
        ocrConfidence: 1,
        linkedOrderId: legacy.id,
        status: 'LINKED',
      },
    });
    const ticketMatch = await prisma.ticketOrderMatch.create({
      data: {
        ticketId: ticket.id,
        orderId: legacy.id,
        matchMethod: 'INTEGRATION_TEST',
        createdBy: user.id,
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: 'INV-LEGACY',
        senderType: 'SUPPLIER',
        supplierId: supplier.id,
        invoiceDate: new Date('2026-09-03'),
        totalAmount: '31',
        currency: 'CAD',
        fileUrl: 'https://example.invalid/invoice.pdf',
        emailFrom: 'integration@example.invalid',
        emailSubject: 'Integration invoice',
        gmailMessageId: 'integration-message-1',
      },
    });
    const invoiceLine = await prisma.invoiceLineItem.create({
      data: {
        invoiceId: invoice.id,
        lineNumber: 1,
        poNumber: 'LEGACY-PO',
        description: 'Garden Soil Bulk',
        quantity: '3',
        unit: 'CY',
        unitRate: '10.333333',
        lineTotal: '31',
        matchedOrderId: legacy.id,
        flag: 'OK',
      },
    });

    const summary = await OrderPdfImportService.applyReport(
      prisma,
      reports.ITEM_TRACKING,
      'legacy-adoption'
    );
    assert.equal(summary.conflicts, 0);

    const adopted = await prisma.order.findUniqueOrThrow({
      where: { id: legacy.id },
      include: {
        deliveries: true,
        tickets: true,
        ticketMatches: true,
        lineItems: true,
      },
    });
    assert.ok(adopted.documentId);
    assert.equal(adopted.spruceItemNumber, 'SOILGRDNA');
    assert.equal(adopted.hasInvoice, true);
    assert.equal(adopted.invoiceNumber, 'INV-LEGACY');
    assert.equal(adopted.poNumber, 'LEGACY-PO');
    assert.equal(adopted.supplierId, supplier.id);
    assert.equal(adopted.driverId, driver.id);
    assert.equal(adopted.deliveryStatus, 'IN_TRANSIT');
    assert.equal(adopted.priority, 9);
    assert.deepEqual(adopted.deliveries.map(row => row.id), [delivery.id]);
    assert.deepEqual(adopted.tickets.map(row => row.id), [ticket.id]);
    assert.deepEqual(adopted.ticketMatches.map(row => row.id), [ticketMatch.id]);
    assert.deepEqual(adopted.lineItems.map(row => row.id), [invoiceLine.id]);
  });

  it('applies multiple POs to repeated codes one-to-one and leaves the header unset', async () => {
    const supplier = await seedSupplier('VENDOR01');
    const document = await prisma.orderDocument.create({
      data: {
        documentNumber: '2608-799999',
        customerName: 'Integration Customer',
        orderDate: new Date('2026-09-02'),
      },
    });
    const large = await prisma.order.create({
      data: {
        spruceOrderId: '2608-799999-L1',
        documentId: document.id,
        lineNumber: 1,
        spruceItemNumber: 'USKID',
        customerName: 'Integration Customer',
        product: 'Unilock Skid Deposit',
        quantity: '6',
        unit: 'EA',
        orderDate: new Date('2026-09-02'),
      },
    });
    const small = await prisma.order.create({
      data: {
        spruceOrderId: '2608-799999-L2',
        documentId: document.id,
        lineNumber: 2,
        spruceItemNumber: 'USKID',
        customerName: 'Integration Customer',
        product: 'Unilock Skid Deposit',
        quantity: '1',
        unit: 'EA',
        orderDate: new Date('2026-09-02'),
      },
    });
    const rows: PoReportRow[] = [{
      documentNumber: document.documentNumber,
      poNumber: null,
      poNumbers: ['PO-LARGE', 'PO-SMALL'],
      pageNumber: 1,
      rowNumber: 10,
    }];
    const lines: PoReportLine[] = [
      {
        documentNumber: document.documentNumber,
        poNumber: 'PO-SMALL',
        itemNumber: 'USKID',
        product: 'Unilock Skid Deposit',
        quantity: 1,
        unit: 'EA',
        vendorCode: 'VENDOR01',
        pageNumber: 1,
        rowNumber: 10,
      },
      {
        documentNumber: document.documentNumber,
        poNumber: 'PO-LARGE',
        itemNumber: 'USKID',
        product: 'Unilock Skid Deposit',
        quantity: 6,
        unit: 'EA',
        vendorCode: 'VENDOR01',
        pageNumber: 1,
        rowNumber: 11,
      },
    ];

    const first = await applyPoReportMerge(rows, lines);
    assert.equal(first.documentsUpdated, 1);
    assert.equal(first.documentsSkipped, 0);
    assert.equal(first.linesUpdated, 2);

    const [storedDocument, storedLarge, storedSmall] = await Promise.all([
      prisma.orderDocument.findUniqueOrThrow({ where: { id: document.id } }),
      prisma.order.findUniqueOrThrow({ where: { id: large.id } }),
      prisma.order.findUniqueOrThrow({ where: { id: small.id } }),
    ]);
    assert.equal(storedDocument.poNumber, null);
    assert.equal(storedLarge.poNumber, 'PO-LARGE');
    assert.equal(storedSmall.poNumber, 'PO-SMALL');
    assert.equal(storedLarge.supplierId, supplier.id);
    assert.equal(storedSmall.supplierId, supplier.id);

    const second = await applyPoReportMerge(rows, lines);
    assert.equal(second.documentsUpdated, 0);
    assert.equal(second.linesUpdated, 0);
    assert.equal(second.lineConflicts.length, 0);
  });

  it('replays complete partial-job details only to the uploader or an admin', async () => {
    const uploader = await prisma.user.create({
      data: {
        name: 'Uploader',
        email: 'uploader@example.invalid',
        passwordHash: 'test-only',
        role: 'AP_USER',
      },
    });
    const otherAp = await prisma.user.create({
      data: {
        name: 'Other AP',
        email: 'other-ap@example.invalid',
        passwordHash: 'test-only',
        role: 'AP_USER',
      },
    });
    const admin = await prisma.user.create({
      data: {
        name: 'Admin',
        email: 'admin@example.invalid',
        passwordHash: 'test-only',
        role: 'ADMIN',
      },
    });
    const job = await prisma.spruceImportJob.create({
      data: {
        uploadedById: uploader.id,
        fileUrl: 'sanitized-report.pdf',
        status: 'PARTIAL',
        finishedAt: new Date(),
        totalRows: 4,
        createdCount: 1,
        updatedCount: 1,
        unchangedCount: 1,
        absentCount: 2,
        conflictCount: 1,
        skippedCount: 1,
        errorSummary: 'One row needs review',
        rowErrors: {
          create: {
            rowNumber: 9,
            rawRowData: '',
            errorMessage: 'Ambiguous repeated item code',
          },
        },
      },
    });

    async function invoke(user: { id: string; email: string; role: 'AP_USER' | 'ADMIN' }) {
      let statusCode = 200;
      let body: any;
      const response = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(value: unknown) {
          body = value;
          return this;
        },
      };
      await getPdfImportJob(
        { params: { jobId: job.id }, user } as any,
        response as any
      );
      return { statusCode, body };
    }

    const own = await invoke({ id: uploader.id, email: uploader.email, role: 'AP_USER' });
    assert.equal(own.statusCode, 200);
    assert.deepEqual(own.body.counts, {
      total: 4,
      created: 1,
      updated: 1,
      unchanged: 1,
      absent: 2,
      conflicts: 1,
      skipped: 1,
    });
    assert.deepEqual(own.body.errors, [
      { rowNumber: 9, error: 'Ambiguous repeated item code' },
    ]);

    const denied = await invoke({ id: otherAp.id, email: otherAp.email, role: 'AP_USER' });
    assert.equal(denied.statusCode, 404);

    const supported = await invoke({ id: admin.id, email: admin.email, role: 'ADMIN' });
    assert.equal(supported.statusCode, 200);
  });
});
