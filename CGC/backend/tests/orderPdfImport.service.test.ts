/**
 * Persistence behaviour of the PDF import, driven through the same parsers
 * production uses but against an in-memory client — pdf2json rejects
 * machine-generated PDFs, so real bytes cannot reach this path from a test.
 *
 * What is pinned here: a re-import updates its own rows instead of
 * duplicating them; cross-report imports keep one row per item whatever order
 * each report prints; workflow state survives every refresh.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrismaClient } from '@prisma/client';

import { OrderPdfImportService } from '../src/modules/orders/orderPdfImport.service.js';
import { parseSprucePages } from '../src/modules/orders/spruce/parseSprucePdf.js';
import {
  itemTrackingReport,
  orderSummaryReport,
} from './fixtures/spruceLayouts.js';

interface FakeOrder {
  id: string;
  spruceOrderId: string;
  documentId: string | null;
  product: string;
  quantity: string;
  unit: string | null;
  spruceItemNumber: string | null;
  lineNumber: number | null;
  poNumber: string | null;
  customerName: string;
  supplierId: string | null;
  orderDate: Date;
  deliveryDate: Date | null;
  hasInvoice: boolean;
  deliveryStatus: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
  driverId: string | null;
  _count: { deliveries: number; lineItems: number; tickets: number; ticketMatches: number };
}

function makeClient() {
  const orders = new Map<string, FakeOrder>();
  const documents = new Map<string, { id: string; documentNumber: string }>();
  let seq = 0;

  const tx = {
    orderDocument: {
      upsert: async ({ where, update, create }: any) => {
        const existing = documents.get(where.documentNumber);
        if (existing) {
          Object.assign(existing, update);
          return { id: existing.id };
        }
        const doc = { id: `doc-${++seq}`, ...create };
        documents.set(where.documentNumber, doc);
        return { id: doc.id };
      },
    },
    order: {
      findMany: async ({ where }: any) => {
        const all = [...orders.values()];
        if (!where?.OR) return all;
        return all.filter((o: FakeOrder) =>
          where.OR.some((cond: any) => {
            if (cond.documentId !== undefined && cond.documentId !== null) {
              return o.documentId === cond.documentId;
            }
            if (
              cond.documentId === null &&
              cond.spruceOrderId &&
              typeof cond.spruceOrderId === 'object'
            ) {
              return (
                o.documentId === null &&
                String(o.spruceOrderId).startsWith(cond.spruceOrderId.startsWith)
              );
            }
            if (cond.documentId === null && typeof cond.spruceOrderId === 'string') {
              return o.documentId === null && o.spruceOrderId === cond.spruceOrderId;
            }
            return false;
          })
        );
      },
      update: async ({ where, data }: any) => {
        const o = orders.get(where.id)!;
        Object.assign(o, data);
        return o;
      },
      create: async ({ data }: any) => {
        const o = {
          id: `ord-${++seq}`,
          deliveryStatus: 'NOT_STARTED',
          driverId: null,
          _count: { deliveries: 0, lineItems: 0, tickets: 0, ticketMatches: 0 },
          ...data,
        } as FakeOrder;
        orders.set(o.id, o);
        return o;
      },
    },
  };

  return {
    supplierSpruceVendor: { findMany: async () => [] },
    $transaction: (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx),
    __orders: orders,
    __documents: documents,
  } as unknown as PrismaClient & { __orders: Map<string, FakeOrder> };
}

function seedLegacyRow(orders: Map<string, FakeOrder>): void {
  orders.set('legacy', {
    id: 'legacy',
    spruceOrderId: '2608-700001-P1-T1-2',
    documentId: null,
    product: 'Garden Soil Bulk',
    quantity: '3',
    unit: 'CY',
    spruceItemNumber: null,
    lineNumber: null,
    poNumber: null,
    customerName: 'Riverbend Landscaping',
    supplierId: null,
    orderDate: new Date('2026-01-01'),
    deliveryDate: null,
    hasInvoice: true,
    deliveryStatus: 'NOT_STARTED',
    driverId: null,
    _count: { deliveries: 0, lineItems: 1, tickets: 1, ticketMatches: 1 },
  });
}

describe('OrderPdfImportService.applyReport', () => {
  it('imports a report once and re-imports it without duplicating a line', async () => {
    const client = makeClient();
    const report = parseSprucePages(itemTrackingReport());

    const first = await OrderPdfImportService.applyReport(client, report, 'job-1');
    assert.equal(first.created, report.rows.length);
    assert.equal(first.conflicts, 0);
    assert.equal(client.__orders.size, report.rows.length);

    const second = await OrderPdfImportService.applyReport(client, report, 'job-2');
    assert.equal(second.created, 0, 'a re-import must not create anything');
    assert.equal(second.updated + second.unchanged, report.rows.length);
    assert.equal(client.__orders.size, report.rows.length, 'no duplicates beside the originals');
  });

  it('keeps one row per item when a different report prints them in another order', async () => {
    const client = makeClient();

    await OrderPdfImportService.applyReport(
      client,
      parseSprucePages(itemTrackingReport()),
      'job-1'
    );
    const soilBefore = [...client.__orders.values()].find(o => o.spruceItemNumber === 'SOILGRDNA');
    assert.ok(soilBefore, 'the item-tracking import recorded the soil line');

    const second = await OrderPdfImportService.applyReport(
      client,
      parseSprucePages(orderSummaryReport()),
      'job-2'
    );

    const soils = [...client.__orders.values()].filter(o => o.spruceItemNumber === 'SOILGRDNA');
    assert.equal(soils.length, 1, 'the same item must not gain a duplicate');
    assert.equal(soils[0]!.id, soilBefore!.id, 'the original row keeps its identity');

    // The order summary's extra lines land as new rows on their own document.
    assert.ok(second.created > 0);
  });

  it('adopts a Textract-era row without touching its invoice state', async () => {
    const client = makeClient();
    seedLegacyRow(client.__orders);
    const report = parseSprucePages(itemTrackingReport());

    const summary = await OrderPdfImportService.applyReport(client, report, 'job-1');

    const legacy = client.__orders.get('legacy')!;
    assert.equal(legacy.hasInvoice, true, 'no report may reset invoice state');
    assert.equal(legacy.documentId, 'doc-1', 'the row was adopted onto its document');
    assert.equal(legacy.spruceItemNumber, 'SOILGRDNA', 'it gained its item code');
    assert.equal(summary.created, report.rows.length - 1, 'only the genuinely new lines were created');
  });

  it('stores Spruce slash dates as the day they name, month-first', async () => {
    const client = makeClient();

    await OrderPdfImportService.applyReport(
      client,
      parseSprucePages(itemTrackingReport()),
      'job-1'
    );

    const soil = [...client.__orders.values()].find(o => o.spruceItemNumber === 'SOILGRDNA')!;
    // The fixture prints 9/2/2026 — September the second. Under the previous
    // day-first convention this was stored as February.
    assert.match(soil.orderDate.toISOString(), /^2026-09-02/);
  });

  it('reports lines the report does not mention instead of deleting them', async () => {
    const client = makeClient();
    await OrderPdfImportService.applyReport(
      client,
      parseSprucePages(itemTrackingReport()),
      'job-1'
    );

    const before = client.__orders.size;
    const summary = await OrderPdfImportService.applyReport(
      client,
      parseSprucePages(orderSummaryReport()),
      'job-2'
    );

    assert.ok(summary.absent > 0, 'item-tracking-only lines are reported absent');
    assert.equal(client.__orders.size, before + summary.created, 'absent lines were kept');
  });

  it('does not expose database internals in row errors', async () => {
    const client = makeClient() as any;
    client.$transaction = async () => {
      throw new Error(
        'Invalid `tx.order.findMany()` invocation at D:\\private\\orderPdfImport.service.ts'
      );
    };

    const summary = await OrderPdfImportService.applyReport(
      client,
      parseSprucePages(orderSummaryReport()),
      'job-1'
    );

    assert.ok(summary.errors.length > 0);
    for (const error of summary.errors) {
      assert.match(error.error, /Retry this report/);
      assert.doesNotMatch(error.error, /findMany|D:\\private|\.service\.ts/);
    }
  });
});
