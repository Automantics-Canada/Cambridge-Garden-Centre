import './setupEnv.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { prisma } from '../src/db/prisma.js';
import { businessDayOf } from '../src/lib/businessDay.js';
import { DispatchService } from '../src/modules/dispatch/dispatch.service.js';
import { fulfilmentByDocument } from '../src/modules/dispatch/dispatchOrderView.js';
import { MISSING_FILTERS } from '../src/modules/orders/orderList.service.js';
import { linkTicketCopies } from '../src/modules/tickets/ticketCopies.js';
import { DEMO_DOCS as D, DEMO_USERS, seedDemo, wipeAppTables } from '../src/scripts/seedDemo.js';

/**
 * The local demo dataset (npm run seed:demo) against a real database: it
 * seeds every scenario the client's answers changed, and running it again
 * gives the same data rather than twice as much.
 *
 * Loopback, disposable database only (scripts/run-tests.mjs): the seed
 * empties every table of the app.
 */

const confirmed = process.env.CGC_TEST_CONFIRM_DISPOSABLE === '1';
const loopback = (() => {
  try {
    return ['127.0.0.1', 'localhost', '::1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname);
  } catch {
    return false;
  }
})();

/** How many rows every table of the app holds. */
async function tableCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const model of Prisma.dmmf.datamodel.models) {
    const table = model.dbName ?? model.name;
    const [row] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*) AS count FROM "${table}"`);
    counts[table] = Number(row!.count);
  }
  return counts;
}

const documentOf = (documentNumber: string) =>
  prisma.orderDocument.findUniqueOrThrow({
    where: { documentNumber },
    include: { lines: true, delivery: { include: { driver: true } }, pickupSupplier: true },
  });

describe('demo seed', { skip: !(confirmed && loopback) }, () => {
  let firstCounts: Record<string, number>;
  let today: string;

  before(async () => {
    today = businessDayOf();
    await seedDemo();
    firstCounts = await tableCounts();
    // The second run is the one every assertion below reads.
    await seedDemo();
  });

  after(async () => {
    // Later suites truncate only the tables they use; leave none of ours behind.
    await wipeAppTables();
    await prisma.$disconnect();
  });

  it('running it again gives the same data, not twice as much', async () => {
    assert.deepEqual(await tableCounts(), firstCounts);
    assert.equal(firstCounts.OrderDocument, Object.keys(D).length);
    assert.equal(firstCounts.ImportBatch, 2, "yesterday's upload and today's");
  });

  it('has a login for every role, and the drivers are linked to their logins', async () => {
    const users = await prisma.user.findMany({ include: { driver: true } });
    assert.deepEqual(
      users.map(user => user.email).sort(),
      Object.values(DEMO_USERS).map(user => user.email).sort()
    );
    assert.deepEqual([...new Set(users.map(user => user.role))].sort(), ['ADMIN', 'AP_USER', 'DRIVER', 'OWNER']);
    for (const user of users.filter(u => u.role === 'DRIVER')) assert.ok(user.driver, `${user.email} has a driver`);
    assert.ok(users.every(user => user.email.endsWith('@demo.invalid')));
    assert.equal(await prisma.driver.count({ where: { type: 'INDEPENDENT', userId: null } }), 1);
  });

  it('A1: FOB orders are the customer\'s to collect, unless the office sends a truck', async () => {
    const collects = await documentOf(D.fobCollects);
    assert.equal(collects.isPickup, true, 'off the pools');
    const hauled = await documentOf(D.fobHauled);
    assert.equal(hauled.fulfilmentOverride, 'supplier_haul_delivery');
    assert.equal(hauled.isPickup, false);

    const how = await fulfilmentByDocument(prisma, [collects.id, hauled.id]);
    assert.equal(how.get(collects.id)?.type, 'external_pickup');
    assert.deepEqual(how.get(hauled.id)?.places[0], {
      name: 'Examplestone', location: 'Ayr', address: '12 Demo Quarry Rd, Ayr ON', po: '9999-880002',
    });
  });

  it('puts today\'s scenarios where the board shows them', async () => {
    const board = await DispatchService.getDispatchBoard(undefined, today);
    const pool = new Map(board.unassignedOrders.map(order => [order.spruceOrderId, order]));

    // A1, A3: neither the FOB order nor the quotation is work for a driver.
    assert.equal(pool.has(D.fobCollects), false);
    assert.equal(pool.has(D.quote), false);
    // A2: the supplier delivery wording stays CGC work, with a check.
    assert.ok(pool.get(D.directDeliveryWording)?.fulfilment?.checks.includes('SUPPLIER_DELIVERY_NOTED'));
    // A5: a PitBlk order nobody has named a pit for yet.
    assert.ok(pool.get(D.pitUnnamed)?.fulfilment?.checks.includes('NO_SUPPLIER_PO'));
    // A6: charge-only, undated, on no Deliveries report.
    assert.equal(pool.get(D.chargeOnlySlinger)?.likelyDelivered, true);
    assert.equal(pool.get(D.chargeOnlyTriaxle)?.likelyDelivered, true);
    assert.equal(pool.get(D.yardPoolA)?.likelyDelivered, false);
    // A7: in both uploads, marked Updated, one set of lines.
    assert.ok(pool.get(D.reimported)?.updatedFields.includes('quantity'));
    // A14: a carrier on the load and no rate.
    const unpriced = pool.get(D.carrierNoRate)?.haulLoads ?? [];
    assert.equal(unpriced.length, 1);
    assert.equal(unpriced[0]!.carrierName, 'Demo Haulage Ltd.');
    assert.equal(unpriced[0]!.rate, null);

    assert.deepEqual(board.carriedOver.map(order => order.spruceOrderId), [D.carriedOver]);

    const run = (name: string) => board.drivers.find(driver => driver.name.startsWith(name))!.deliveries;
    // A1 exception and A5: where the driver loads.
    const dana = run('Dana');
    assert.deepEqual(dana.map(stop => stop.order.spruceOrderId), [D.yardDoneToday, D.fobHauled, D.yardRun]);
    assert.equal(dana[0]!.status, 'DELIVERED');
    const drew = run('Drew');
    assert.deepEqual(drew[0]!.order.pickupFrom, [{
      name: 'Sample Sand & Gravel', location: 'North Dumfries', address: '900 Example Sideroad, North Dumfries ON', po: null,
    }]);
    // A4: a PO means the CGC driver collects at that supplier.
    assert.equal(drew[1]!.order.pickupFrom?.[0]?.name, 'Demo Pavers Inc.');
    // A4/A14: one brokered trip, two POs, the rate set.
    const casey = run('Casey');
    assert.deepEqual(casey.map(stop => stop.order.spruceOrderId), [D.tripFirst, D.tripSecond]);
    for (const stop of casey) {
      const [load] = stop.order.haulLoads ?? [];
      assert.equal(load?.tripRef, 'DEMO-TRIP-TODAY');
      assert.equal(load?.rate, 145);
      assert.equal(load?.trip?.loads, 2);
    }
  });

  it('every stop was placed, started and finished in that order, and none in the future', async () => {
    // Whatever time of day the seed runs: an early-morning run once finished
    // today's stop before it was placed.
    const now = Date.now();
    for (const stop of await prisma.delivery.findMany()) {
      assert.ok(stop.createdAt.getTime() <= now, 'placed in the past');
      if (stop.startedAt) assert.ok(stop.startedAt >= stop.createdAt, 'started after it was placed');
      if (stop.completedAt) {
        assert.ok(stop.startedAt && stop.completedAt >= stop.startedAt, 'finished after it started');
        assert.ok(stop.completedAt.getTime() <= now, 'finished in the past');
      }
    }
    // This morning's mail has arrived already, too.
    const received = [
      ...(await prisma.invoice.findMany({ select: { receivedAt: true } })),
      ...(await prisma.ticket.findMany({ select: { receivedAt: true } })),
      ...(await prisma.emailIngestionEvent.findMany({ select: { receivedAt: true } })),
    ];
    for (const { receivedAt } of received) assert.ok(receivedAt.getTime() <= now, 'received in the past');
  });

  it('A3: the quotation is flagged, and A7: the re-imported order has no duplicate lines', async () => {
    assert.ok((await documentOf(D.quote)).flags.includes('QUOTE'));

    const reimported = await documentOf(D.reimported);
    assert.equal(reimported.lines.length, 2);
    assert.equal(Number(reimported.lines.find(line => line.spruceItemNumber === 'SOILGRDNA')?.quantity), 12);
    const batches = await prisma.importBatchFile.findMany({ select: { batchId: true, extraction: true } });
    const carrying = new Set(
      batches
        .filter(file => JSON.stringify(file.extraction).includes(D.reimported))
        .map(file => file.batchId)
    );
    assert.equal(carrying.size, 2, 'present in both uploads');
    assert.ok(await prisma.orderChange.count({ where: { documentId: reimported.id } }) > 0);
  });

  it('A8: only a delivery that was on a Deliveries report is missing a phone', async () => {
    const missing = await prisma.orderDocument.findMany({ where: MISSING_FILTERS.phone, select: { documentNumber: true } });
    const numbers = missing.map(document => document.documentNumber);
    assert.ok(numbers.includes(D.noPhoneDelivery));
    assert.equal(numbers.includes(D.noPhonePickup), false);
    assert.ok((await documentOf(D.noPhoneDelivery)).flags.includes('NO_PHONE'));
    assert.deepEqual((await documentOf(D.noPhonePickup)).flags, []);
  });

  it('A12/A14: invoices from Excel and PDF, matched by the engine', async () => {
    const invoices = await prisma.invoice.findMany({
      include: { supportingFiles: true, lineItems: { include: { matchResult: true }, orderBy: { lineNumber: 'asc' } } },
    });
    assert.equal(invoices.length, 3);
    assert.ok(invoices.some(invoice => invoice.fileUrl.endsWith('.xlsx')));
    const pavers = invoices.find(invoice => invoice.invoiceNumber === 'DP-5001')!;
    assert.equal(pavers.supportingFiles.length, 1);

    for (const line of invoices.flatMap(invoice => invoice.lineItems)) {
      assert.ok(line.matchResult, `line ${line.description} has an engine verdict`);
    }
    const [byCode, overBilled] = pavers.lineItems;
    assert.equal(byCode!.flag, 'OK');
    assert.match(JSON.stringify(byCode!.matchResult!.evidence), /found by item code DPCHAR60/);
    assert.equal(overBilled!.flag, 'RATE_MISMATCH');

    assert.equal(await prisma.negotiatedRate.count({ where: { spruceItemCode: { not: null } } }), 5);
    assert.equal(await prisma.dispatchLoad.count({ where: { carrierSupplier: { type: 'TRUCKING_COMPANY' }, rate: { not: null } } }), 5);
  });

  it('A14: the trucking invoice is checked line by line against the loads dispatch recorded', async () => {
    const haul = await prisma.invoice.findFirstOrThrow({
      where: { invoiceNumber: 'DH-301' },
      include: { lineItems: { include: { matchResult: true }, orderBy: { lineNumber: 'asc' } } },
    });
    assert.equal(haul.senderType, 'TRUCKING_COMPANY');
    const code = (line: (typeof haul.lineItems)[number], name: string) =>
      (line.matchResult!.evidence as Array<{ name: string; passed: boolean; code?: string }>).find(check => check.name === name);
    const [trip, overBilled, unpriced] = haul.lineItems;
    for (const line of haul.lineItems) {
      assert.ok(line.ticketNumber, `line ${line.lineNumber} carries its ticket`);
      assert.equal(line.serviceDate?.toISOString().slice(0, 10), haul.invoiceDate.toISOString().slice(0, 10));
    }

    // Yesterday's brokered trip: one haul over two orders, at the rate dispatch set.
    assert.equal(trip!.matchResult!.status, 'MATCHED', trip!.matchResult!.reason);
    assert.equal(trip!.matchResult!.loadIds.length, 2);
    assert.equal(Number(trip!.approvedTotal), 140);
    assert.equal(trip!.flag, 'OK');

    assert.equal(code(overBilled!, 'haulRate')?.code, 'RATE_MISMATCH');
    assert.equal(overBilled!.flag, 'RATE_MISMATCH');
    assert.equal(Number(overBilled!.negotiatedRate), 150);
    assert.equal(Number(overBilled!.approvedTotal), 150);

    assert.equal(code(unpriced!, 'haulRate')?.code, 'NO_RATE_SET');
    assert.equal(unpriced!.matchResult!.status, 'PARTIAL');
    assert.equal(unpriced!.approvedTotal, null);

    // Nothing is paid until somebody verifies: no load is claimed.
    assert.equal(await prisma.dispatchLoad.count({ where: { claimedByLineItemId: { not: null } } }), 0);
  });

  it("A15: the supplier's emailed ticket is linked to the driver's, as the app would link it", async () => {
    const emailed = await prisma.ticket.findFirstOrThrow({ where: { source: 'EMAIL' } });
    const driverCopy = await prisma.ticket.findFirstOrThrow({ where: { ticketNumber: 'DP-70001', source: 'MANUAL' } });
    assert.equal(emailed.duplicateOfTicketId, driverCopy.id);

    const outcome = await linkTicketCopies(emailed.id);
    assert.equal(outcome.primaryId, driverCopy.id);
    assert.equal(outcome.changed, false, 'the seed already wrote what the app writes');
  });

  it('A9-A12: the mailbox log has a review queue, an ignored email, a statement and an .xls', async () => {
    const events = await prisma.emailIngestionEvent.findMany();
    const byStatus = (status: string) => events.filter(event => event.status === status);
    assert.deepEqual(byStatus('NEEDS_REVIEW').map(event => event.reviewReason).sort(), ['SPREADSHEET', 'UNKNOWN_SENDER']);
    assert.equal(byStatus('IGNORED').length, 1);
    assert.ok(byStatus('IGNORED')[0]!.reviewedById);
    assert.ok(JSON.stringify(byStatus('PROCESSED').map(event => event.attachments)).includes('"statement"'));
  });
});
