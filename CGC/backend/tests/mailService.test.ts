import './setupEnv.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import nodemailer from 'nodemailer';

// MailService talks to two things: nodemailer and Prisma. Both are replaced
// here, so no SMTP connection is ever opened and no database is needed.
//
// Prisma: src/db/prisma.ts reuses `globalThis.Prisma` outside production, so a
// stand-in placed there before the service is imported is the client it uses.
const driverRows = new Map<string, unknown>();
const deliveryRows = new Map<string, unknown>();
(globalThis as { Prisma?: unknown }).Prisma = {
  driver: { findUnique: async ({ where }: { where: { id: string } }) => driverRows.get(where.id) ?? null },
  delivery: { findUnique: async ({ where }: { where: { id: string } }) => deliveryRows.get(where.id) ?? null },
};

// nodemailer: the service calls `nodemailer.createTransport(...)` on the
// default export, so replacing that method hands it a fake transport.
type SentMail = { from?: string; to?: string; subject?: string; text?: string; html?: string };
const transportConfigs: unknown[] = [];
const sent: SentMail[] = [];
let sendMailImpl: (mail: SentMail) => Promise<{ messageId: string }>;

mock.method(nodemailer, 'createTransport', (config: unknown) => {
  transportConfigs.push(config);
  return {
    sendMail: async (mail: SentMail) => {
      sent.push(mail);
      return sendMailImpl(mail);
    },
  };
});

process.env.GMAIL_USER = 'dispatch@example.test';
process.env.GMAIL_PASS = 'test-only-app-password';
process.env.FRONTEND_URL = 'https://app.example.test';

const { MailService } = await import('../src/services/mail.service.js');

const driverUser = {
  id: '00000000-0000-0000-0000-0000000000d1',
  email: 'driver@example.test',
  role: 'DRIVER',
  active: true,
};
const driver = { id: 'driver-1', name: 'Dana Driver', email: 'driver@example.test', user: driverUser };

let errors: unknown[][];

beforeEach((t) => {
  sent.length = 0;
  sendMailImpl = async () => ({ messageId: '<test-message@example.test>' });
  errors = [];
  // The service logs timings and outcomes; keep the test output clean but
  // record errors so the error-path logging can be checked.
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'time', () => {});
  t.mock.method(console, 'timeEnd', () => {});
  t.mock.method(console, 'error', (...args: unknown[]) => {
    errors.push(args);
  });
  driverRows.clear();
  deliveryRows.clear();
});

afterEach(() => {
  driverRows.clear();
  deliveryRows.clear();
});

describe('MailService.sendEmail', () => {
  it('sends from the dispatch address and turns plain-text line breaks into html', async () => {
    const result = await MailService.sendEmail('to@example.test', 'Subject line', 'Line one\nLine two');

    assert.deepEqual(result, { success: true, messageId: '<test-message@example.test>' });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], {
      from: '"CGC Dispatch" <dispatch@example.test>',
      to: 'to@example.test',
      subject: 'Subject line',
      text: 'Line one\nLine two',
      html: 'Line one<br>Line two',
    });
  });

  it('passes explicit html through unchanged', async () => {
    await MailService.sendEmail('to@example.test', 'S', 'plain', '<p>rich</p>');
    assert.equal(sent[0]?.html, '<p>rich</p>');
    assert.equal(sent[0]?.text, 'plain');
  });

  it('builds the Gmail transport once, with the app password when GMAIL_PASS is set', async () => {
    await MailService.sendEmail('a@example.test', 'S', 'one');
    await MailService.sendEmail('b@example.test', 'S', 'two');

    assert.equal(transportConfigs.length, 1, 'the transport is created once and reused');
    assert.deepEqual(transportConfigs[0], {
      service: 'gmail',
      auth: { user: 'dispatch@example.test', pass: 'test-only-app-password' },
    });
  });

  it('uses Gmail OAuth2 when no app password is configured', async (t) => {
    // The transport is cached per module, so a second copy of the module is
    // loaded (the query string makes it a separate instance) without GMAIL_PASS.
    const saved = { ...process.env };
    t.after(() => {
      process.env = saved;
    });
    delete process.env.GMAIL_PASS;
    process.env.GMAIL_CLIENT_ID = 'test-client-id';
    process.env.GMAIL_CLIENT_SECRET = 'test-client-secret';
    process.env.GMAIL_REFRESH_TOKEN = 'test-refresh-token';
    const before = transportConfigs.length;

    const fresh = await import('../src/services/mail.service.js?oauth2');
    await fresh.MailService.sendEmail('to@example.test', 'S', 'body');

    assert.equal(transportConfigs.length, before + 1);
    assert.deepEqual(transportConfigs.at(-1), {
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: 'dispatch@example.test',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        refreshToken: 'test-refresh-token',
      },
    });
  });

  it('returns the error message instead of throwing when the send fails', async () => {
    sendMailImpl = async () => {
      throw Object.assign(new Error('Connection refused'), { code: 'ECONNECTION' });
    };

    const result = await MailService.sendEmail('to@example.test', 'S', 'body');

    assert.deepEqual(result, { success: false, error: 'Connection refused' });
    assert.ok(errors.some((args) => args[0] === '[MAIL] Error sending email:'));
    assert.ok(!errors.some((args) => String(args[0]).includes('AUTHENTICATION FAILED')));
  });

  it('adds the authentication hint for EAUTH failures', async () => {
    sendMailImpl = async () => {
      throw Object.assign(new Error('Invalid login'), { code: 'EAUTH' });
    };

    const result = await MailService.sendEmail('to@example.test', 'S', 'body');

    assert.deepEqual(result, { success: false, error: 'Invalid login' });
    assert.ok(errors.some((args) => String(args[0]).includes('AUTHENTICATION FAILED')));
  });
});

describe('MailService.sendAssignmentEmail', () => {
  it('emails the driver a link to their day with the order details', async () => {
    driverRows.set(driver.id, driver);
    deliveryRows.set('delivery-1', {
      id: 'delivery-1',
      order: { spruceOrderId: '2608-700001', customerName: 'Sample Customer', product: 'Mulch', quantity: 3, unit: 'YD' },
    });

    const result = await MailService.sendAssignmentEmail(driver.id, 'delivery-1');

    assert.equal(result.success, true);
    assert.equal(sent.length, 1);
    const mail = sent[0]!;
    assert.equal(mail.to, 'driver@example.test');
    assert.equal(mail.subject, '🚚 New Assignment: 2608-700001 - Action Required');
    assert.match(mail.text ?? '', /assigned a new delivery task: 2608-700001 for Sample Customer\./);
    assert.match(mail.text ?? '', /https:\/\/app\.example\.test\/driver\/today\?token=[\w-]+\.[\w-]+\.[\w-]+/);
    assert.match(mail.html ?? '', /3 YD/);
  });

  it('sends nothing when the driver, their email or the delivery is missing', async () => {
    assert.deepEqual(await MailService.sendAssignmentEmail('missing', 'delivery-1'), {
      success: false,
      error: 'Driver not found',
    });

    driverRows.set('no-email', { ...driver, id: 'no-email', email: null });
    assert.deepEqual(await MailService.sendAssignmentEmail('no-email', 'delivery-1'), {
      success: false,
      error: 'Driver has no registered email',
    });

    driverRows.set(driver.id, driver);
    assert.deepEqual(await MailService.sendAssignmentEmail(driver.id, 'missing'), {
      success: false,
      error: 'Delivery not found',
    });

    assert.equal(sent.length, 0);
  });

  it('refuses a driver whose login is inactive', async () => {
    driverRows.set(driver.id, { ...driver, user: { ...driverUser, active: false } });
    deliveryRows.set('delivery-1', { id: 'delivery-1', order: { spruceOrderId: 'X' } });

    const result = await MailService.sendAssignmentEmail(driver.id, 'delivery-1');

    assert.deepEqual(result, { success: false, error: 'Driver account is not linked or active' });
    assert.equal(sent.length, 0);
  });
});

describe('MailService.sendPriorityUpdateEmail', () => {
  it('emails the driver a link to the updated board', async () => {
    driverRows.set(driver.id, driver);

    const result = await MailService.sendPriorityUpdateEmail(driver.id);

    assert.equal(result.success, true);
    assert.equal(sent[0]?.to, 'driver@example.test');
    assert.equal(sent[0]?.subject, '⚠️ Sequence Updated: Your Delivery Board has changed');
    assert.match(sent[0]?.html ?? '', /https:\/\/app\.example\.test\/driver\/today\?token=/);
  });

  it('sends nothing for an unknown driver or one without an email', async () => {
    assert.deepEqual(await MailService.sendPriorityUpdateEmail('missing'), { success: false, error: 'Driver not found' });
    driverRows.set('no-email', { ...driver, id: 'no-email', email: null });
    assert.deepEqual(await MailService.sendPriorityUpdateEmail('no-email'), { success: false, error: 'No email' });
    assert.equal(sent.length, 0);
  });
});
