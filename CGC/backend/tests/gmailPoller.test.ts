import './setupEnv.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { google } from 'googleapis';

/**
 * The invoice inbox poller, with Gmail, Prisma and invoice ingest replaced.
 *
 * No network and no database. googleapis: `google.gmail(...)` is replaced
 * before the service is imported, so both clients it builds are fakes backed by
 * one in-memory mailbox. Prisma: src/db/prisma.ts reuses `globalThis.Prisma`
 * outside production, so a stand-in placed there first is the client it uses.
 *
 * Every address, label and id is invented.
 */

// Outbound (driver email) and inbox credentials differ, so a test can tell
// which client made a call.
process.env.GMAIL_CLIENT_ID = 'outbound-client-id.test';
process.env.GMAIL_CLIENT_SECRET = 'outbound-client-secret-test';
process.env.GMAIL_REFRESH_TOKEN = 'outbound-refresh-token-test';
process.env.GMAIL_INBOX_CLIENT_ID = 'inbox-client-id.test';
process.env.GMAIL_INBOX_CLIENT_SECRET = 'inbox-client-secret-test';
process.env.GMAIL_INBOX_REFRESH_TOKEN = 'inbox-refresh-token-test';

const INBOX = 'invoices-inbox@example.test';
const FORWARDER = 'ap@garden-centre.test';
const SUPPLIER = 'billing@stone-supplier.test';
const AUTH_PASS =
  'mx.google.com; dkim=pass header.i=@garden-centre.test header.s=s1 header.b=x; ' +
  'spf=pass smtp.mailfrom=ap@garden-centre.test; dmarc=pass (p=NONE) header.from=garden-centre.test';

// ---------------------------------------------------------------- fake Gmail

type FakePart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { attachmentId?: string; data?: string };
  parts?: FakePart[];
};
type FakeMessage = { id: string; labelIds: string[]; payload: FakePart };

const mailbox = {
  profile: INBOX,
  labels: [] as Array<{ id: string; name: string }>,
  messages: [] as FakeMessage[],
  /** Bumped per attachments.get, so attachment ids are never the same twice. */
  fetches: 0,
  failList: null as Error | null,
};
const calls: Array<{ client: 'inbox' | 'outbound'; method: string; args: any }> = [];

function b64(text: string) {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function labelId(name: string) {
  return mailbox.labels.find(l => l.name.toLowerCase() === name.toLowerCase())?.id;
}

/** A small, honest subset of Gmail search: label, -label, is:unread. */
function matches(message: FakeMessage, q: string) {
  for (const [, neg, name] of q.matchAll(/(-?)label:"([^"]+)"/g)) {
    const id = labelId(name!);
    const has = id !== undefined && message.labelIds.includes(id);
    if (neg ? has : !has) return false;
  }
  if (/\bis:unread\b/.test(q) && !message.labelIds.includes('UNREAD')) return false;
  return true;
}

function fakeClient(client: 'inbox' | 'outbound') {
  const record = (method: string, args: any) => calls.push({ client, method, args });
  return {
    users: {
      getProfile: async (args: any) => {
        record('getProfile', args);
        return { data: { emailAddress: mailbox.profile } };
      },
      labels: {
        list: async (args: any) => {
          record('labels.list', args);
          return { data: { labels: mailbox.labels.map(l => ({ ...l })) } };
        },
        create: async (args: any) => {
          record('labels.create', args);
          const label = { id: `Label_${mailbox.labels.length + 1}`, name: args.requestBody.name };
          mailbox.labels.push(label);
          return { data: label };
        },
      },
      messages: {
        list: async (args: any) => {
          record('messages.list', args);
          if (mailbox.failList) throw mailbox.failList;
          const all = mailbox.messages.filter(m => matches(m, args.q));
          const start = Number(args.pageToken ?? 0);
          const page = all.slice(start, start + args.maxResults);
          const next = start + args.maxResults < all.length ? String(start + args.maxResults) : undefined;
          return { data: { messages: page.map(m => ({ id: m.id })), ...(next ? { nextPageToken: next } : {}) } };
        },
        get: async (args: any) => {
          record('messages.get', args);
          const message = mailbox.messages.find(m => m.id === args.id)!;
          // Gmail hands out a fresh attachmentId on every fetch; the key must not depend on it.
          const reissue = (part: FakePart): FakePart => ({
            ...part,
            ...(part.body?.attachmentId ? { body: { attachmentId: `ATT-${part.partId}-${++mailbox.fetches}` } } : {}),
            ...(part.parts ? { parts: part.parts.map(reissue) } : {}),
          });
          return { data: { id: message.id, labelIds: [...message.labelIds], payload: reissue(message.payload) } };
        },
        modify: async (args: any) => {
          record('messages.modify', args);
          const message = mailbox.messages.find(m => m.id === args.id)!;
          const remove: string[] = args.requestBody.removeLabelIds ?? [];
          message.labelIds = [...new Set([...message.labelIds, ...(args.requestBody.addLabelIds ?? [])])]
            .filter(id => !remove.includes(id));
          return { data: {} };
        },
        send: async (args: any) => {
          record('messages.send', args);
          return { data: { id: 'sent-1' } };
        },
        attachments: {
          get: async (args: any) => {
            record('attachments.get', args);
            return { data: { data: b64(`%PDF-1.4 fake invoice ${args.messageId} ${args.id.split('-')[1]}`) } };
          },
        },
      },
    },
  };
}

const builtWith: string[] = [];
mock.method(google, 'gmail', (options: any) => {
  const token = options.auth?.credentials?.refresh_token as string | undefined;
  const client = token === 'inbox-refresh-token-test' ? 'inbox' : 'outbound';
  builtWith.push(client);
  return fakeClient(client);
});

// ------------------------------------------------------------ fake Prisma

const invoices = new Map<string, { gmailMessageId: string; fromEmail: string; subject: string }>();
const events = new Map<string, any>();
const settings = new Map<string, unknown>();
let failIngestFor: string | null = null;

(globalThis as { Prisma?: unknown }).Prisma = {
  invoice: {
    findMany: async ({ where }: any) =>
      [...invoices.keys()]
        .filter(key => key.startsWith(where.gmailMessageId.startsWith))
        .map(gmailMessageId => ({ gmailMessageId })),
  },
  emailIngestionEvent: {
    findUnique: async ({ where }: any) => events.get(where.gmailMessageId) ?? null,
    create: async ({ data }: any) => {
      if (events.has(data.gmailMessageId)) throw Object.assign(new Error('unique'), { code: 'P2002' });
      events.set(data.gmailMessageId, data);
      return data;
    },
  },
  systemSetting: {
    upsert: async ({ where, create, update }: any) => {
      settings.set(where.key, (settings.has(where.key) ? update : create).value);
      return {};
    },
    findUnique: async ({ where }: any) => (settings.has(where.key) ? { value: settings.get(where.key) } : null),
  },
};

const { InvoiceService } = await import('../src/modules/invoices/invoice.service.js');
mock.method(InvoiceService, 'ingestEmailInvoice', async (params: any) => {
  if (failIngestFor && params.gmailMessageId === failIngestFor) throw new Error('storage unavailable');
  if (invoices.has(params.gmailMessageId)) throw Object.assign(new Error('unique'), { code: 'P2002' });
  invoices.set(params.gmailMessageId, { gmailMessageId: params.gmailMessageId, fromEmail: params.fromEmail, subject: params.subject });
  return { invoice: { id: `inv-${invoices.size}` }, ocrJob: { id: `job-${invoices.size}` } };
});

const { GmailService, PAGE_SIZE, MAX_PAGES } = await import('../src/services/gmail.service.js');
const { readGmailInboxConfig, buildInboxQuery, gmailPollDisabledReason } = await import('../src/config/gmailConfig.js');
const { readGmailStatus, deriveGmailHealth, GMAIL_STATUS_KEY } = await import('../src/services/gmailStatus.js');

const ocrJobs: string[] = [];
GmailService.triggerOcr = (id: string) => { ocrJobs.push(id); };

// ------------------------------------------------------------- fixtures

const BASE_ENV = {
  GMAIL_INBOX_CLIENT_ID: 'inbox-client-id.test',
  GMAIL_INBOX_CLIENT_SECRET: 'inbox-client-secret-test',
  GMAIL_INBOX_REFRESH_TOKEN: 'inbox-refresh-token-test',
  GMAIL_INVOICE_LABEL: 'cgc-invoices',
  GMAIL_SENDER_ALLOWLIST: 'stone-supplier.test',
  GMAIL_TRUSTED_FORWARDERS: FORWARDER,
  GMAIL_POLL_AFTER: '2026-11-02',
};

function config(overrides: Record<string, string | undefined> = {}) {
  return readGmailInboxConfig({ ...BASE_ENV, ...overrides });
}

let nextId = 1;
function addMessage(options: {
  from?: string;
  extraHeaders?: Record<string, string>;
  text?: string;
  attachments?: Array<{ filename: string; mimeType?: string }>;
  unread?: boolean;
  labelled?: boolean;
} = {}) {
  const id = `msg-${String(nextId++).padStart(4, '0')}`;
  const attachments = options.attachments ?? [{ filename: 'invoice-90001.pdf', mimeType: 'application/pdf' }];
  const headers = [
    { name: 'From', value: options.from ?? `Stone Supplier <${SUPPLIER}>` },
    { name: 'To', value: INBOX },
    { name: 'Subject', value: `Invoice for ${id}` },
    ...Object.entries(options.extraHeaders ?? {}).map(([name, value]) => ({ name, value })),
  ];
  mailbox.messages.unshift({
    id,
    labelIds: [
      ...(options.labelled === false ? [] : [labelId('cgc-invoices')!]),
      ...(options.unread === false ? [] : ['UNREAD']),
      'INBOX',
    ],
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      headers,
      parts: [
        { partId: '0', mimeType: 'text/plain', body: { data: b64(options.text ?? 'Invoice attached.') } },
        ...attachments.map((a, i) => ({
          partId: String(i + 1),
          mimeType: a.mimeType ?? 'application/pdf',
          filename: a.filename,
          body: { attachmentId: `ATT-${i + 1}-0` },
        })),
      ],
    },
  });
  return id;
}

function labelsOf(id: string) {
  const message = mailbox.messages.find(m => m.id === id)!;
  return message.labelIds.map(l => mailbox.labels.find(x => x.id === l)?.name ?? l);
}

function inboxCalls(method: string) {
  return calls.filter(c => c.client === 'inbox' && c.method === method);
}

function status() {
  return settings.get(GMAIL_STATUS_KEY) as any;
}

beforeEach((t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  mailbox.profile = INBOX;
  mailbox.labels = [{ id: 'Label_invoices', name: 'cgc-invoices' }];
  mailbox.messages = [];
  mailbox.failList = null;
  calls.length = 0;
  invoices.clear();
  events.clear();
  settings.clear();
  ocrJobs.length = 0;
  failIngestFor = null;
  GmailService.resetState();
});

// ---------------------------------------------------------------- tests

describe('credentials', () => {
  it('builds the outbound client from GMAIL_* and the inbox client from GMAIL_INBOX_*', () => {
    assert.deepEqual([...builtWith].sort(), ['inbox', 'outbound']);
  });

  it('polls through the inbox client only, and sends driver email through the outbound one', async () => {
    addMessage();
    await GmailService.pollInvoices(config());
    await GmailService.sendEmail('driver@example.test', 'Welcome', '<p>Hi</p>');

    assert.ok(calls.some(c => c.client === 'inbox' && c.method === 'messages.list'));
    assert.equal(calls.filter(c => c.client === 'outbound' && c.method !== 'messages.send').length, 0);
    assert.deepEqual(calls.filter(c => c.method === 'messages.send').map(c => c.client), ['outbound']);
  });

  it('each inbox setting falls back to the shared GMAIL_* value', () => {
    const fallback = readGmailInboxConfig({
      GMAIL_CLIENT_ID: 'shared-id', GMAIL_CLIENT_SECRET: 'shared-secret', GMAIL_REFRESH_TOKEN: 'shared-token', GMAIL_USER: 'Dispatch@Example.test',
    });
    assert.equal(fallback.clientId, 'shared-id');
    assert.equal(fallback.clientSecret, 'shared-secret');
    assert.equal(fallback.refreshToken, 'shared-token');
    assert.equal(fallback.user, 'dispatch@example.test');
    assert.equal(fallback.userExplicit, false);

    const own = readGmailInboxConfig({
      GMAIL_REFRESH_TOKEN: 'shared-token', GMAIL_INBOX_REFRESH_TOKEN: 'inbox-token',
      GMAIL_USER: 'dispatch@example.test', GMAIL_INBOX_USER: INBOX,
    });
    assert.equal(own.refreshToken, 'inbox-token');
    assert.equal(own.user, INBOX);
    assert.equal(own.userExplicit, true);
  });
});

describe('configuration', () => {
  it('defaults: ingest mode, the cgc-processed label, no cutoff', () => {
    const c = readGmailInboxConfig({});
    assert.equal(c.ingestMode, 'ingest');
    assert.equal(c.processedLabel, 'cgc-processed');
    assert.equal(c.observedLabel, 'cgc-observed');
    assert.equal(c.pollAfter, null);
  });

  it('trusted forwarders are full addresses only', () => {
    const c = readGmailInboxConfig({ GMAIL_TRUSTED_FORWARDERS: ' AP@Garden-Centre.test , garden-centre.test, @garden-centre.test ' });
    assert.deepEqual(c.trustedForwarders, [FORWARDER]);
  });

  it('a mistyped mode or date stops polling instead of guessing', () => {
    assert.match(gmailPollDisabledReason(config({ GMAIL_INGEST_MODE: 'observ' }))!, /GMAIL_INGEST_MODE/);
    assert.match(gmailPollDisabledReason(config({ GMAIL_POLL_AFTER: '2026-02-30' }))!, /GMAIL_POLL_AFTER/);
    assert.match(gmailPollDisabledReason(config({ GMAIL_POLL_AFTER: '11/02/2026' }))!, /GMAIL_POLL_AFTER/);
  });

  it('needs credentials and a label; ingest also needs an allowlist, observe does not', () => {
    assert.match(gmailPollDisabledReason(config({ GMAIL_INBOX_REFRESH_TOKEN: '' }))!, /credentials/);
    assert.match(gmailPollDisabledReason(config({ GMAIL_INVOICE_LABEL: '' }))!, /GMAIL_INVOICE_LABEL/);
    assert.match(gmailPollDisabledReason(config({ GMAIL_SENDER_ALLOWLIST: '' }))!, /GMAIL_SENDER_ALLOWLIST/);
    assert.equal(gmailPollDisabledReason(config({ GMAIL_SENDER_ALLOWLIST: '', GMAIL_INGEST_MODE: 'observe' })), null);
    assert.match(gmailPollDisabledReason(config({ GMAIL_PROCESSED_LABEL: 'CGC-Invoices' }))!, /must all differ/);
  });
});

describe('query', () => {
  it('excludes the processed label and adds the cutoff, with no is:unread', () => {
    const q = buildInboxQuery(config());
    assert.equal(q, 'has:attachment label:"cgc-invoices" -label:"cgc-processed" after:2026/11/02');
  });

  it('keeps is:unread while no cutoff is set, so an upgrade cannot reach mail already read', () => {
    assert.equal(
      buildInboxQuery(config({ GMAIL_POLL_AFTER: undefined })),
      'has:attachment label:"cgc-invoices" -label:"cgc-processed" is:unread'
    );
  });

  it('observe mode also excludes the observed label', () => {
    assert.match(buildInboxQuery(config({ GMAIL_INGEST_MODE: 'observe' })), /-label:"cgc-observed"/);
  });

  it('sends that query to Gmail', async () => {
    await GmailService.pollInvoices(config());
    assert.equal(inboxCalls('messages.list')[0]!.args.q, buildInboxQuery(config()));
  });
});

describe('processed label', () => {
  it('creates the label once when missing, then adds it and marks the message read', async () => {
    const id = addMessage();
    await GmailService.pollInvoices(config());
    await GmailService.pollInvoices(config());

    assert.equal(inboxCalls('labels.create').length, 1);
    assert.equal(inboxCalls('labels.create')[0]!.args.requestBody.name, 'cgc-processed');
    assert.ok(labelsOf(id).includes('cgc-processed'));
    assert.ok(!labelsOf(id).includes('UNREAD'));
    assert.equal(invoices.size, 1);
    assert.deepEqual(ocrJobs, ['job-1']);
  });

  it('a message somebody already opened in Gmail is still ingested', async () => {
    const id = addMessage({ unread: false });
    await GmailService.pollInvoices(config());
    assert.ok(invoices.has(`${id}:1`));
  });

  it('without a cutoff an opened message is left alone, as before', async () => {
    addMessage({ unread: false });
    await GmailService.pollInvoices(config({ GMAIL_POLL_AFTER: undefined }));
    assert.equal(invoices.size, 0);
  });

  it('a failed attachment leaves the message unlabelled, and the retry adds only what is missing', async () => {
    const id = addMessage({ attachments: [{ filename: 'a.pdf' }, { filename: 'b.pdf' }] });
    failIngestFor = `${id}:2`;
    await GmailService.pollInvoices(config());

    assert.deepEqual([...invoices.keys()], [`${id}:1`]);
    assert.ok(!labelsOf(id).includes('cgc-processed'));
    assert.equal(status().counts.failed, 1);

    failIngestFor = null;
    await GmailService.pollInvoices(config());
    assert.deepEqual([...invoices.keys()].sort(), [`${id}:1`, `${id}:2`]);
    assert.ok(labelsOf(id).includes('cgc-processed'));
    assert.equal(status().counts.duplicates, 1);
  });

  it('a message with no PDF or image is labelled done without an invoice', async () => {
    const id = addMessage({ attachments: [{ filename: 'notes.docx', mimeType: 'application/msword' }] });
    await GmailService.pollInvoices(config());
    assert.equal(invoices.size, 0);
    assert.ok(labelsOf(id).includes('cgc-processed'));
    assert.equal(status().counts.noAttachments, 1);
  });
});

describe('idempotency', () => {
  it('keys each attachment by messageId:partId, however often Gmail changes the attachmentId', async () => {
    const id = addMessage();
    await GmailService.pollInvoices(config());
    // Somebody removes the label by hand; the message comes back to the query.
    mailbox.messages[0]!.labelIds = mailbox.messages[0]!.labelIds.filter(l => l !== labelId('cgc-processed'));
    await GmailService.pollInvoices(config());

    assert.deepEqual([...invoices.keys()], [`${id}:1`]);
    assert.equal(status().counts.duplicates, 1);
  });

  it('never ingests again a message the old poller keyed by attachmentId', async () => {
    const id = addMessage({ unread: false });
    invoices.set(`${id}:ANGjdJ8-legacyAttachmentIdFromTheOldPoller`, { gmailMessageId: `${id}:ANGjdJ8-legacy`, fromEmail: SUPPLIER, subject: 'x' });

    await GmailService.pollInvoices(config());

    assert.equal(invoices.size, 1, 'no second invoice for the same email');
    assert.equal(inboxCalls('attachments.get').length, 0);
    assert.ok(labelsOf(id).includes('cgc-processed'));
    assert.equal(status().counts.legacySkipped, 1);
  });

  it('falls back to a content hash when Gmail reports no part id', async () => {
    const id = addMessage();
    delete mailbox.messages[0]!.payload.parts![1]!.partId;
    await GmailService.pollInvoices(config());
    const [key] = [...invoices.keys()];
    assert.match(key!, new RegExp(`^${id}:sha256-[0-9a-f]{32}$`));
  });
});

describe('paging', () => {
  it('follows nextPageToken', async () => {
    for (let i = 0; i < PAGE_SIZE + 5; i += 1) addMessage();
    await GmailService.pollInvoices(config());

    assert.equal(inboxCalls('messages.list').length, 2);
    assert.equal(inboxCalls('messages.list')[1]!.args.pageToken, String(PAGE_SIZE));
    assert.equal(invoices.size, PAGE_SIZE + 5);
    assert.equal(status().truncated, false);
  });

  it('reads at most MAX_PAGES pages a poll and says more are waiting', async () => {
    for (let i = 0; i < PAGE_SIZE * MAX_PAGES + 3; i += 1) addMessage();
    await GmailService.pollInvoices(config());

    assert.equal(inboxCalls('messages.list').length, MAX_PAGES);
    assert.equal(invoices.size, PAGE_SIZE * MAX_PAGES);
    assert.equal(status().truncated, true);

    await GmailService.pollInvoices(config());
    assert.equal(invoices.size, PAGE_SIZE * MAX_PAGES + 3);
  });
});

describe('sender gate', () => {
  it('ingests a forward from the trusted forwarder under the original supplier', async () => {
    addMessage({
      from: `Accounts Payable <${FORWARDER}>`,
      extraHeaders: { 'Authentication-Results': AUTH_PASS },
      text: `FYI\n\n-----Original Message-----\nFrom: Stone Supplier <${SUPPLIER}>\nSent: Monday\nSubject: Invoice 90001\n`,
    });
    await GmailService.pollInvoices(config());

    const [invoice] = [...invoices.values()];
    assert.equal(invoice?.fromEmail, SUPPLIER, 'supplier lookup must see the supplier, not the AP mailbox');
  });

  it('a redirect keeps the supplier as the sender', async () => {
    addMessage({ extraHeaders: { 'Resent-From': FORWARDER } });
    await GmailService.pollInvoices(config());
    assert.equal([...invoices.values()][0]?.fromEmail, SUPPLIER);
  });

  it('mail the forwarder wrote itself is not a supplier, even with the forwarder on the allowlist', async () => {
    const id = addMessage({ from: FORWARDER, extraHeaders: { 'Authentication-Results': AUTH_PASS }, text: 'Statement attached.' });
    await GmailService.pollInvoices(config({ GMAIL_SENDER_ALLOWLIST: `stone-supplier.test,${FORWARDER}` }));

    assert.equal(invoices.size, 0);
    assert.ok(!labelsOf(id).includes('cgc-processed'), 'left for a person');
    assert.equal(status().counts.unresolvedSender, 1);
  });

  it('a forward naming a supplier off the allowlist is refused, and not fetched again', async () => {
    addMessage({
      from: FORWARDER,
      extraHeaders: { 'Authentication-Results': AUTH_PASS },
      text: '-----Original Message-----\nFrom: someone@unknown-sender.test\nSent: Monday\nSubject: Hi\n',
    });
    await GmailService.pollInvoices(config());
    await GmailService.pollInvoices(config());

    assert.equal(invoices.size, 0);
    assert.equal(inboxCalls('messages.get').length, 1);
    assert.equal(status().counts.rejectedSender, 1);
  });

  it('a direct sender off the allowlist is refused', async () => {
    addMessage({ from: 'someone@unknown-sender.test' });
    await GmailService.pollInvoices(config());
    assert.equal(invoices.size, 0);
  });
});

describe('observe mode', () => {
  const observe = () => config({ GMAIL_INGEST_MODE: 'observe', GMAIL_SENDER_ALLOWLIST: '' });

  it('records who sent what, creates no invoice and leaves the message unread', async () => {
    const id = addMessage({
      from: FORWARDER,
      extraHeaders: { 'Authentication-Results': AUTH_PASS },
      text: `-----Original Message-----\nFrom: Stone Supplier <${SUPPLIER}>\nSent: Monday\nSubject: Invoice\n`,
      attachments: [{ filename: 'inv.pdf', mimeType: 'application/pdf' }, { filename: 'detail.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
    });
    await GmailService.pollInvoices(observe());

    assert.equal(invoices.size, 0);
    assert.equal(inboxCalls('attachments.get').length, 0, 'observe never downloads attachments');
    const event = events.get(id);
    assert.equal(event.fromAddress, SUPPLIER);
    assert.equal(event.toAddress, INBOX);
    assert.match(event.errorMessage, /mode=forward/);
    assert.match(event.errorMessage, /forwardedBy=ap@garden-centre\.test/);
    assert.match(event.errorMessage, /allowlisted=no/);
    assert.match(event.errorMessage, /inv\.pdf \(application\/pdf\), detail\.xlsx/);
    assert.deepEqual(labelsOf(id).filter(l => l.startsWith('cgc-')).sort(), ['cgc-invoices', 'cgc-observed']);
    assert.ok(labelsOf(id).includes('UNREAD'));
    assert.equal(status().mode, 'observe');
    assert.equal(status().counts.observed, 1);
  });

  it('records each message once, and switching to ingest still reads it', async () => {
    addMessage();
    await GmailService.pollInvoices(observe());
    await GmailService.pollInvoices(observe());
    assert.equal(events.size, 1);
    assert.equal(inboxCalls('messages.get').length, 1);

    await GmailService.pollInvoices(config());
    assert.equal(invoices.size, 1);
  });

  it('records an unresolvable forward too, under the forwarder, marked unknown', async () => {
    const id = addMessage({ from: FORWARDER, extraHeaders: { 'Authentication-Results': AUTH_PASS }, text: 'see attached' });
    await GmailService.pollInvoices(observe());
    assert.equal(events.get(id).fromAddress, FORWARDER);
    assert.match(events.get(id).errorMessage, /mode=unknown/);
  });
});

describe('status for the health endpoint', () => {
  it('records mode, labels, cutoff, counts and the masked mailbox, with no secret', async () => {
    addMessage();
    await GmailService.pollInvoices(config());

    const s = status();
    assert.equal(s.enabled, true);
    assert.equal(s.lastResult, 'ok');
    assert.equal(s.mode, 'ingest');
    assert.equal(s.invoiceLabel, 'cgc-invoices');
    assert.equal(s.invoiceLabelFound, true);
    assert.equal(s.processedLabel, 'cgc-processed');
    assert.equal(s.pollAfter, '2026-11-02');
    assert.equal(s.mailbox, 'in…@example.test');
    assert.equal(s.counts.listed, 1);
    assert.equal(s.counts.processed, 1);
    assert.equal(s.counts.invoicesCreated, 1);
    assert.ok(s.lastSuccessAt);

    const text = JSON.stringify(s);
    for (const secret of ['inbox-refresh-token-test', 'inbox-client-secret-test', 'outbound-refresh-token-test', INBOX, SUPPLIER]) {
      assert.ok(!text.includes(secret), `status must not contain ${secret}`);
    }

    const health = deriveGmailHealth(await readGmailStatus());
    assert.equal(health.reported, true);
    assert.equal(health.stale, false);
    assert.equal(health.counts?.invoicesCreated, 1);
  });

  it('says why polling is disabled, without touching Gmail', async () => {
    await GmailService.pollInvoices(config({ GMAIL_INVOICE_LABEL: '' }));
    assert.equal(status().enabled, false);
    assert.equal(status().lastResult, 'disabled');
    assert.match(status().disabledReason, /GMAIL_INVOICE_LABEL/);
    assert.equal(calls.length, 0);
  });

  it('stops when the token is for another mailbox than GMAIL_INBOX_USER', async () => {
    addMessage();
    mailbox.profile = 'someone-else@example.test';
    await GmailService.pollInvoices(config({ GMAIL_INBOX_USER: INBOX }));

    assert.equal(invoices.size, 0);
    assert.equal(inboxCalls('messages.list').length, 0);
    assert.equal(status().enabled, false);
    assert.equal(status().mailboxMatchesConfig, false);
    assert.match(status().disabledReason, /different mailbox/);
  });

  it('only warns when the mismatch is against the GMAIL_USER fallback', async () => {
    addMessage();
    mailbox.profile = 'someone-else@example.test';
    await GmailService.pollInvoices(config({ GMAIL_USER: 'dispatch@example.test' }));
    assert.equal(invoices.size, 1);
    assert.equal(status().mailboxMatchesConfig, false);
  });

  it('reports a missing invoice label in the mailbox', async () => {
    mailbox.labels = [];
    await GmailService.pollInvoices(config());
    assert.equal(status().invoiceLabelFound, false);
  });

  it('records a Gmail failure without the token-like parts of the message', async () => {
    mailbox.failList = new Error(`invalid_grant for ${INBOX}: token ya29.a0AfH6SMBexampleexampleexampleexample`);
    await GmailService.pollInvoices(config());

    assert.equal(status().lastResult, 'error');
    assert.equal(status().lastSuccessAt, null);
    assert.match(status().lastError, /^invalid_grant/);
    assert.ok(!status().lastError.includes('ya29.a0AfH6SMBexample'));
    assert.ok(!status().lastError.includes(INBOX));
  });
});
