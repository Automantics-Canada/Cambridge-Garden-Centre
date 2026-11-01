// config/env.ts validates the environment at import time, so the placeholder
// config has to be loaded before anything under src/ is pulled in.
import './setupEnv.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import jwt from 'jsonwebtoken';

import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { invalidateKnownSenders } from '../src/services/knownSenders.js';

/**
 * The email review queue and known senders, against PostgreSQL.
 *
 * The poller's side (what lands in the queue) is tests/gmailPoller.test.ts.
 * These check the office's side: listing the queue, approving a sender (the
 * supplier gains the address or domain, and that sender's waiting emails are
 * re-queued), ignoring, and who may do which. Also that an email invoice
 * takes its supplier and sender type from the supplier records, and that the
 * supplier form's sender rules hold on the API. Every name and address is
 * invented.
 */

const confirmed = process.env.CGC_TEST_CONFIRM_DISPOSABLE === '1';
const loopback = (() => {
  try {
    return ['127.0.0.1', 'localhost', '::1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname);
  } catch {
    return false;
  }
})();

describe('email review queue (PostgreSQL)', { skip: !(confirmed && loopback) }, () => {
  let server: Server;
  let baseUrl: string;
  const tokens: Record<string, string> = {};
  let stoneId: string;
  const realFetch = globalThis.fetch;

  async function api(method: string, path: string, body?: unknown, role = 'OWNER') {
    const response = await realFetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${tokens[role]}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  let nextMessage = 1;
  function queued(originalFrom: string | null, over: Record<string, unknown> = {}) {
    const id = `msg-review-${nextMessage++}`;
    return prisma.emailIngestionEvent.create({
      data: {
        gmailMessageId: id,
        subject: `Invoice ${id}`,
        fromAddress: originalFrom ?? 'ap@garden-centre.test',
        toAddress: 'invoices-inbox@example.test',
        originalFrom,
        senderMode: originalFrom ? 'direct' : 'unknown',
        status: 'NEEDS_REVIEW',
        reviewReason: originalFrom ? 'UNKNOWN_SENDER' : 'UNRESOLVED_SENDER',
        attachments: [{ name: 'invoice.pdf', mimeType: 'application/pdf', size: 1000, partId: '1', kind: 'pdf', action: 'held', reason: 'waiting for the sender to be approved' }],
        ...over,
      },
    });
  }

  before(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "EmailIngestionEvent", "OcrJob", "InvoiceLineItem", "Invoice", "Supplier", "User" RESTART IDENTITY CASCADE'
    );
    for (const role of ['AP_USER', 'OWNER', 'ADMIN', 'DRIVER'] as const) {
      const user = await prisma.user.create({
        data: { name: `${role} person`, email: `${role.toLowerCase()}-review@example.invalid`, passwordHash: 'x', role },
      });
      tokens[role] = jwt.sign({ id: user.id, email: user.email, role: user.role }, env.jwtSecret);
    }
    stoneId = (await prisma.supplier.create({ data: { name: 'Example Stone', type: 'SUPPLIER', emailDomains: [] } })).id;

    const { default: app } = await import('../src/app.js');
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(() => invalidateKnownSenders());

  after(async () => {
    server?.close();
    await prisma.$disconnect();
  });

  it('a new supplier starts with no addresses, and the queue statuses exist', async () => {
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: stoneId } });
    assert.deepEqual(supplier.emailAddresses, []);
    const event = await queued('first@new-supplier.test');
    assert.equal(event.status, 'NEEDS_REVIEW');
    assert.deepEqual(event.createdInvoiceIds, []);
    await prisma.emailIngestionEvent.update({ where: { id: event.id }, data: { status: 'IGNORED' } });
  });

  it('the office can see the queue; a driver cannot', async () => {
    await queued('billing@new-supplier.test');
    const desk = await api('GET', '/api/email-events', undefined, 'AP_USER');
    assert.equal(desk.status, 200);
    assert.ok(desk.body.events.length >= 1);
    assert.equal(desk.body.events[0].originalFrom, 'billing@new-supplier.test');
    assert.equal(desk.body.events[0].attachments[0].name, 'invoice.pdf');
    assert.ok(desk.body.counts.NEEDS_REVIEW >= 1);
    assert.equal(desk.body.counts.IGNORED, 1);

    assert.equal((await api('GET', '/api/email-events', undefined, 'DRIVER')).status, 403);
    assert.equal((await api('GET', '/api/email-events?status=PROCESSED', undefined, 'AP_USER')).status, 400);
  });

  it('AP_USER and DRIVER may not approve or ignore', async () => {
    const event = await queued('someone@other-new.test');
    for (const role of ['AP_USER', 'DRIVER']) {
      assert.equal((await api('POST', `/api/email-events/${event.id}/approve`, { supplierId: stoneId }, role)).status, 403);
      assert.equal((await api('POST', `/api/email-events/${event.id}/ignore`, {}, role)).status, 403);
    }
  });

  it('approving an address adds it to the supplier and re-queues that sender only', async () => {
    const first = await queued('accounts@stone-new.test');
    const second = await queued('Accounts@Stone-New.test');
    const colleague = await queued('other.person@stone-new.test');

    const approved = await api('POST', `/api/email-events/${first.id}/approve`, { supplierId: stoneId, match: 'address' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.deepEqual(approved.body.added, { kind: 'address', value: 'accounts@stone-new.test', alreadyListed: false });
    assert.equal(approved.body.requeued, 2);

    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: stoneId } });
    assert.deepEqual(supplier.emailAddresses, ['accounts@stone-new.test']);

    const rows = await prisma.emailIngestionEvent.findMany({ where: { id: { in: [first.id, second.id, colleague.id] } } });
    const byId = new Map(rows.map(r => [r.id, r]));
    for (const id of [first.id, second.id]) {
      assert.ok(byId.get(id)!.requeuedAt, 'waiting for the poller');
      assert.equal(byId.get(id)!.supplierId, stoneId);
      assert.ok(byId.get(id)!.reviewedById);
      assert.equal(byId.get(id)!.status, 'NEEDS_REVIEW', 'the poller, not the approval, marks it processed');
    }
    assert.equal(byId.get(colleague.id)!.requeuedAt, null);

    // Once is enough: a second approval of the same email is refused.
    const again = await api('POST', `/api/email-events/${first.id}/approve`, { supplierId: stoneId });
    assert.equal(again.status, 409);
  });

  it('approving a domain re-queues everyone at it; a free-mail domain is refused', async () => {
    const one = await queued('a@pavers-new.test');
    const two = await queued('b@pavers-new.test');
    const approved = await api('POST', `/api/email-events/${one.id}/approve`, { supplierId: stoneId, match: 'domain' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.requeued, 2);
    assert.ok((await prisma.emailIngestionEvent.findUniqueOrThrow({ where: { id: two.id } })).requeuedAt);
    assert.ok((await prisma.supplier.findUniqueOrThrow({ where: { id: stoneId } })).emailDomains.includes('pavers-new.test'));

    const gmail = await queued('owner.op@gmail.com');
    const refused = await api('POST', `/api/email-events/${gmail.id}/approve`, { supplierId: stoneId, match: 'domain' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /gmail\.com is shared/);
  });

  it('approving onto a new trucking company creates it with the address', async () => {
    const event = await queued('owner.op2@gmail.com');
    const approved = await api('POST', `/api/email-events/${event.id}/approve`, {
      newSupplier: { name: 'Example Haulage', type: 'TRUCKING_COMPANY' },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const created = await prisma.supplier.findUniqueOrThrow({ where: { id: approved.body.supplier.id } });
    assert.equal(created.type, 'TRUCKING_COMPANY');
    assert.deepEqual(created.emailAddresses, ['owner.op2@gmail.com']);

    const duplicate = await queued('owner.op3@gmail.com');
    const clash = await api('POST', `/api/email-events/${duplicate.id}/approve`, { newSupplier: { name: 'example haulage' } });
    assert.equal(clash.status, 409);
  });

  it('a forward whose sender could not be read cannot be approved, only ignored', async () => {
    const event = await queued(null);
    const approved = await api('POST', `/api/email-events/${event.id}/approve`, { supplierId: stoneId });
    assert.equal(approved.status, 409);
    assert.match(approved.body.error, /could not be read/);

    const ignored = await api('POST', `/api/email-events/${event.id}/ignore`, {}, 'ADMIN');
    assert.equal(ignored.status, 200);
    assert.equal(ignored.body.status, 'IGNORED');
    assert.ok(ignored.body.reviewedAt);
    assert.equal((await api('POST', `/api/email-events/${event.id}/ignore`, {}, 'ADMIN')).status, 409);
    assert.equal((await api('POST', '/api/email-events/not-an-id/ignore', {}, 'ADMIN')).status, 404);
  });

  it('an email invoice takes its supplier and sender type from the supplier records', async () => {
    // Storage is Supabase over fetch; answer it here so nothing leaves the machine.
    const storage = mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.hostname === 'test-project.supabase.co') {
        return new Response(JSON.stringify({ Key: 'test-bucket/synthetic', Id: 'synthetic' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return realFetch(input, init);
    });
    try {
      const haulage = await prisma.supplier.create({
        data: { name: 'Example Dump Trucks', type: 'TRUCKING_COMPANY', emailDomains: [], emailAddresses: ['dispatch.desk@gmail.com'] },
      });
      // A free-mail domain saved before the form refused one.
      await prisma.supplier.create({ data: { name: 'Old Gmail Record', type: 'SUPPLIER', emailDomains: ['gmail.com'] } });
      invalidateKnownSenders();

      const { InvoiceService } = await import('../src/modules/invoices/invoice.service.js');
      const pdf = Buffer.from('%PDF-1.4 synthetic');
      const trucking = await InvoiceService.ingestEmailInvoice({
        buffer: pdf, originalName: 'inv.pdf', fromEmail: '"Dispatch Desk" <Dispatch.Desk@gmail.com>',
        subject: 'Invoice 4401', gmailMessageId: 'msg-sender-type:1',
      });
      assert.equal(trucking.invoice.supplierId, haulage.id);
      assert.equal(trucking.invoice.senderType, 'TRUCKING_COMPANY');

      const stranger = await InvoiceService.ingestEmailInvoice({
        buffer: pdf, originalName: 'inv.pdf', fromEmail: 'someone.random@gmail.com',
        subject: 'Invoice 4402', gmailMessageId: 'msg-sender-type:2',
      });
      const unidentified = await prisma.supplier.findUniqueOrThrow({ where: { id: stranger.invoice.supplierId } });
      assert.equal(unidentified.name, 'Unidentified supplier', 'a gmail.com domain must not claim it');
      assert.equal(stranger.invoice.senderType, 'SUPPLIER');

      // Emailed tickets use the same lookup, display names and all.
      const { findSupplierIdByEmail } = await import('../src/modules/tickets/ticket.service.js');
      assert.equal(await findSupplierIdByEmail('Dispatch Desk <dispatch.desk@gmail.com>'), haulage.id);
      assert.equal(await findSupplierIdByEmail('someone.random@gmail.com'), null);
    } finally {
      storage.mock.restore();
    }
  });

  it('the supplier API sorts domains from addresses and refuses a free-mail domain', async () => {
    const created = await api('POST', '/api/suppliers', {
      name: 'Example Mulch', type: 'SUPPLIER', emailDomains: ['Mulch-Yard.test', 'owner@gmail.com'],
    }, 'AP_USER');
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.emailDomains, ['mulch-yard.test']);
    assert.deepEqual(created.body.emailAddresses, ['owner@gmail.com']);

    const refused = await api('PUT', `/api/suppliers/${created.body.id}`, { emailDomains: ['gmail.com'] });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /shared by many senders/);
  });
});
