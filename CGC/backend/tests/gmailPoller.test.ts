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
type FakeMessage = { id: string; labelIds: string[]; payload: FakePart; internalDate?: string };

const mailbox = {
  profile: INBOX,
  labels: [] as Array<{ id: string; name: string }>,
  messages: [] as FakeMessage[],
  /** Bumped per attachments.get, so attachment ids are never the same twice. */
  fetches: 0,
  /** Attachment bytes by `messageId:partId`; a fake PDF when absent. */
  contents: new Map<string, Buffer>(),
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
          const message = mailbox.messages.find(m => m.id === args.id);
          if (!message) throw Object.assign(new Error('Requested entity was not found.'), { code: 404 });
          // Gmail hands out a fresh attachmentId on every fetch; the key must not depend on it.
          const reissue = (part: FakePart): FakePart => ({
            ...part,
            ...(part.body?.attachmentId ? { body: { ...part.body, attachmentId: `ATT-${part.partId}-${++mailbox.fetches}` } } : {}),
            ...(part.parts ? { parts: part.parts.map(reissue) } : {}),
          });
          return {
            data: {
              id: message.id, labelIds: [...message.labelIds], payload: reissue(message.payload),
              ...(message.internalDate ? { internalDate: message.internalDate } : {}),
            },
          };
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
            const partId = args.id.split('-')[1];
            const content = mailbox.contents.get(`${args.messageId}:${partId}`);
            if (content) return { data: { data: content.toString('base64url') } };
            return { data: { data: b64(`%PDF-1.4 fake invoice ${args.messageId} ${partId}`) } };
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

const invoices = new Map<string, { id: string; gmailMessageId: string; fromEmail: string; subject: string; originalName: string; buffer?: Buffer }>();
/** Emailed tickets by emailSourceKey, as TicketService.ingestEmailTicket made them. */
const tickets = new Map<string, { id: string; emailSourceKey: string; fromEmail: string; supplierId: string | null; originalName: string; buffer?: Buffer }>();
/** Supporting files by gmailKey. */
const supportingFiles = new Map<string, { id: string; invoiceId: string; gmailKey: string; originalName: string; buffer?: Buffer }>();
const events = new Map<string, any>();
const settings = new Map<string, unknown>();
const settingTimes = new Map<string, Date>();
/** Active suppliers as the known-senders lookup reads them. */
const suppliers: Array<{ id: string; name: string; type: 'SUPPLIER' | 'TRUCKING_COMPANY'; emailDomains: string[]; emailAddresses: string[]; contactEmail: string | null }> = [];
let failIngestFor: string | null = null;

(globalThis as { Prisma?: unknown }).Prisma = {
  invoice: {
    findUnique: async ({ where }: any) => {
      const row = invoices.get(where.gmailMessageId);
      return row ? { id: row.id } : null;
    },
    findMany: async ({ where }: any) =>
      [...invoices.values()]
        .filter(row => row.gmailMessageId.startsWith(where.gmailMessageId.startsWith))
        .map(row => ({ id: row.id, gmailMessageId: row.gmailMessageId })),
  },
  supplier: {
    findMany: async () => suppliers.map(s => ({ ...s })),
  },
  ticket: {
    findMany: async ({ where }: any) =>
      [...tickets.values()]
        .filter(row => row.emailSourceKey.startsWith(where.emailSourceKey.startsWith))
        .map(row => ({ id: row.id, emailSourceKey: row.emailSourceKey })),
  },
  invoiceSupportingFile: {
    findMany: async ({ where }: any) =>
      [...supportingFiles.values()]
        .filter(row => row.gmailKey.startsWith(where.gmailKey.startsWith))
        .map(row => ({ gmailKey: row.gmailKey, invoiceId: row.invoiceId })),
  },
  emailIngestionEvent: {
    findUnique: async ({ where }: any) => events.get(where.gmailMessageId) ?? null,
    create: async ({ data }: any) => {
      if (events.has(data.gmailMessageId)) throw Object.assign(new Error('unique'), { code: 'P2002' });
      events.set(data.gmailMessageId, { createdInvoiceIds: [], requeuedAt: null, ...data });
      return data;
    },
    upsert: async ({ where, create, update }: any) => {
      const current = events.get(where.gmailMessageId);
      events.set(where.gmailMessageId, current ? { ...current, ...update } : { ...create });
      return events.get(where.gmailMessageId);
    },
    update: async ({ where, data }: any) => {
      const current = events.get(where.gmailMessageId);
      if (!current) throw Object.assign(new Error('not found'), { code: 'P2025' });
      events.set(where.gmailMessageId, { ...current, ...data });
      return events.get(where.gmailMessageId);
    },
    findMany: async ({ where, take, orderBy }: any) =>
      [...events.values()]
        .filter(e => e.status === where.status)
        .filter(e => (where.requeuedAt?.not === null ? e.requeuedAt != null : true))
        .filter(e => (where.requeuedAt?.lte ? e.requeuedAt != null && e.requeuedAt <= where.requeuedAt.lte : true))
        .sort((a, b) => (orderBy?.requeuedAt === 'asc' ? (a.requeuedAt?.getTime() ?? 0) - (b.requeuedAt?.getTime() ?? 0) : 0))
        .slice(0, take)
        .map(e => ({ gmailMessageId: e.gmailMessageId })),
  },
  systemSetting: {
    upsert: async ({ where, create, update }: any) => {
      settings.set(where.key, (settings.has(where.key) ? update : create).value);
      settingTimes.set(where.key, (settings.has(where.key) ? update : create).updatedAt ?? new Date());
      return {};
    },
    findUnique: async ({ where }: any) => (settings.has(where.key) ? { value: settings.get(where.key) } : null),
    create: async ({ data }: any) => {
      if (settings.has(data.key)) throw Object.assign(new Error('unique'), { code: 'P2002' });
      settings.set(data.key, data.value);
      settingTimes.set(data.key, data.updatedAt ?? new Date());
      return data;
    },
    // Only the shapes the poll lease uses: key, and an OR of an older
    // updatedAt and a holder held in the JSON value.
    updateMany: async ({ where, data }: any) => {
      if (!settings.has(where.key)) return { count: 0 };
      const value = settings.get(where.key) as any;
      const at = settingTimes.get(where.key)!;
      const test = (cond: any): boolean => {
        if (cond.OR) return cond.OR.some(test);
        if (cond.updatedAt?.lt) return at < cond.updatedAt.lt;
        if (cond.value?.path) return value?.[cond.value.path[0]] === cond.value.equals;
        return true;
      };
      const { key: _key, ...rest } = where;
      if (!Object.entries(rest).every(([k, v]) => test({ [k]: v }))) return { count: 0 };
      if ('value' in data) settings.set(where.key, data.value);
      if ('updatedAt' in data) settingTimes.set(where.key, data.updatedAt);
      return { count: 1 };
    },
  },
};

const { InvoiceService } = await import('../src/modules/invoices/invoice.service.js');
/** Runs as an invoice is about to be created: another poller acting at that moment. */
let onIngest: ((params: any) => void) | null = null;
mock.method(InvoiceService, 'ingestEmailInvoice', async (params: any) => {
  onIngest?.(params);
  if (failIngestFor && params.gmailMessageId === failIngestFor) throw new Error('storage unavailable');
  if (invoices.has(params.gmailMessageId)) throw Object.assign(new Error('unique'), { code: 'P2002' });
  const id = `inv-${invoices.size + 1}`;
  invoices.set(params.gmailMessageId, {
    id, gmailMessageId: params.gmailMessageId, fromEmail: params.fromEmail, subject: params.subject, originalName: params.originalName, buffer: params.buffer,
  });
  return { invoice: { id }, ocrJob: { id: `job-${invoices.size}` } };
});
mock.method(InvoiceService, 'attachSupportingFile', async (params: any) => {
  const row = { id: `file-${supportingFiles.size + 1}`, invoiceId: params.invoiceId, gmailKey: params.gmailKey, originalName: params.originalName, buffer: params.buffer };
  supportingFiles.set(params.gmailKey, row);
  return row;
});

const { TicketService } = await import('../src/modules/tickets/ticket.service.js');
mock.method(TicketService, 'ingestEmailTicket', async (params: any) => {
  if (tickets.has(params.emailSourceKey)) throw Object.assign(new Error('unique'), { code: 'P2002' });
  const id = `ticket-${tickets.size + 1}`;
  tickets.set(params.emailSourceKey, {
    id, emailSourceKey: params.emailSourceKey, fromEmail: params.fromEmail, supplierId: params.supplierId ?? null,
    originalName: params.originalName, buffer: params.buffer,
  });
  return { ticket: { id }, ocrJob: { id: `ticket-job-${tickets.size}` } };
});

const { GmailService, PAGE_SIZE, MAX_PAGES, MAX_READ_ATTEMPTS, RETRY_BASE_MS, retryDelayMs } = await import('../src/services/gmail.service.js');
const { readGmailInboxConfig, buildInboxQuery, gmailPollDisabledReason } = await import('../src/config/gmailConfig.js');
const { readGmailStatus, deriveGmailHealth, GMAIL_STATUS_KEY } = await import('../src/services/gmailStatus.js');
const { invalidateKnownSenders } = await import('../src/services/knownSenders.js');
const { ATTACHMENT_REASONS } = await import('../src/services/emailAttachments.js');
const { POLL_LEASE_KEY, POLL_LEASE_MS } = await import('../src/services/gmailLease.js');
const { ExtractionError } = await import('../src/services/extraction/extraction.service.js');

/** The poller's clock; tests move it forward to pass a retry delay. */
let clock = Date.now();
GmailService.now = () => new Date(clock);
const MINUTE = 60_000;

const ocrJobs: string[] = [];
GmailService.triggerOcr = (id: string) => { ocrJobs.push(id); };

/**
 * The page sorting call, with no model: every file is one invoice page unless
 * a test says otherwise. `triageCalls` records what was sent.
 */
type Kind = 'invoice' | 'delivery_ticket' | 'statement' | 'credit_memo' | 'other';
let triageAnswer: (bytes: Buffer, mimeType: string, filename: string) => Kind[] | Error = () => ['invoice'];
const triageCalls: Array<{ mimeType: string; filename: string }> = [];
GmailService.triage = async (bytes: Buffer, mimeType: string, filename: string) => {
  triageCalls.push({ mimeType, filename });
  const answer = triageAnswer(bytes, mimeType, filename);
  if (answer instanceof Error) throw answer;
  return { pages: answer.map((kind, i) => ({ page: i + 1, kind })) };
};

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
  attachments?: Array<{
    filename: string;
    mimeType?: string;
    headers?: Array<{ name: string; value: string }>;
    size?: number;
    content?: Buffer;
  }>;
  unread?: boolean;
  labelled?: boolean;
  /** When Gmail received it; now when left out. */
  receivedAt?: Date;
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
    ...(options.receivedAt ? { internalDate: String(options.receivedAt.getTime()) } : {}),
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
        ...attachments.map((a, i) => {
          if (a.content) mailbox.contents.set(`${id}:${i + 1}`, a.content);
          return {
            partId: String(i + 1),
            mimeType: a.mimeType ?? 'application/pdf',
            filename: a.filename,
            ...(a.headers ? { headers: a.headers } : {}),
            body: { attachmentId: `ATT-${i + 1}-0`, ...(a.size !== undefined ? { size: a.size } : {}) },
          };
        }),
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
  mailbox.contents.clear();
  calls.length = 0;
  invoices.clear();
  tickets.clear();
  supportingFiles.clear();
  triageAnswer = () => ['invoice'];
  triageCalls.length = 0;
  events.clear();
  settings.clear();
  settingTimes.clear();
  suppliers.length = 0;
  invalidateKnownSenders();
  ocrJobs.length = 0;
  failIngestFor = null;
  onIngest = null;
  clock = Date.now();
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
    assert.equal(c.reviewLabel, 'cgc-review');
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

  // An empty allowlist used to stop ingest mode: it was all that stood between
  // a labelled email and an invoice. Unknown senders now go to the review
  // queue and never become invoices, so ingest runs without one.
  it('needs credentials and a label; neither mode needs an allowlist any more', () => {
    assert.match(gmailPollDisabledReason(config({ GMAIL_INBOX_REFRESH_TOKEN: '' }))!, /credentials/);
    assert.match(gmailPollDisabledReason(config({ GMAIL_INVOICE_LABEL: '' }))!, /GMAIL_INVOICE_LABEL/);
    assert.equal(gmailPollDisabledReason(config({ GMAIL_SENDER_ALLOWLIST: '' })), null);
    assert.equal(gmailPollDisabledReason(config({ GMAIL_SENDER_ALLOWLIST: '', GMAIL_INGEST_MODE: 'observe' })), null);
    assert.match(gmailPollDisabledReason(config({ GMAIL_PROCESSED_LABEL: 'CGC-Invoices' }))!, /must all differ/);
    assert.match(gmailPollDisabledReason(config({ GMAIL_REVIEW_LABEL: 'cgc-processed' }))!, /must all differ/);
  });
});

describe('deploying with the variables production already has', () => {
  // Production runs the previous poller with GMAIL_INVOICE_LABEL (and maybe
  // GMAIL_SENDER_ALLOWLIST) and none of the new GMAIL_* settings. That poller
  // left unread every labelled email from a sender off the env allowlist, and
  // did nothing at all with an empty allowlist. This version knows senders
  // from the supplier records too, so polling with the old variables would
  // turn that old unread mail into invoices, or flood the review queue. It
  // does nothing until the go-live date is set.
  const OLD_ENV = {
    GMAIL_INBOX_CLIENT_ID: 'inbox-client-id.test',
    GMAIL_INBOX_CLIENT_SECRET: 'inbox-client-secret-test',
    GMAIL_INBOX_REFRESH_TOKEN: 'inbox-refresh-token-test',
    GMAIL_INVOICE_LABEL: 'cgc-invoices',
    GMAIL_SENDER_ALLOWLIST: 'allowlisted-only.test',
  };

  it('reads, labels and creates nothing without GMAIL_POLL_AFTER, and says why', async () => {
    suppliers.push({
      id: 'sup-1', name: 'Stone Supplier', type: 'SUPPLIER', emailDomains: ['stone-supplier.test'], emailAddresses: [], contactEmail: null,
    });
    const known = addMessage();
    const unknown = addMessage({ from: 'Somebody <someone@unknown-sender.test>' });

    await GmailService.pollInvoices(readGmailInboxConfig(OLD_ENV));

    assert.equal(invoices.size, 0);
    assert.equal(events.size, 0);
    assert.equal(calls.length, 0, 'no Gmail call at all: no label is created or applied');
    assert.deepEqual(labelsOf(known).sort(), ['INBOX', 'UNREAD', 'cgc-invoices']);
    assert.deepEqual(labelsOf(unknown).sort(), ['INBOX', 'UNREAD', 'cgc-invoices']);
    assert.equal(status().enabled, false);
    assert.match(status().disabledReason, /GMAIL_POLL_AFTER is not set/);
  });

  it('observe mode needs the date too: a census of old unread mail would label it', async () => {
    addMessage({ from: 'Somebody <someone@unknown-sender.test>' });
    await GmailService.pollInvoices(readGmailInboxConfig({ ...OLD_ENV, GMAIL_INGEST_MODE: 'observe' }));
    assert.equal(events.size, 0);
    assert.equal(calls.length, 0);
    assert.match(status().disabledReason, /GMAIL_POLL_AFTER/);
  });

  it('with the date set, polling starts', () => {
    assert.equal(gmailPollDisabledReason(readGmailInboxConfig({ ...OLD_ENV, GMAIL_POLL_AFTER: '2026-11-02' })), null);
  });
});

describe('query', () => {
  it('excludes the processed and review labels and adds the cutoff, with no is:unread', () => {
    const q = buildInboxQuery(config());
    assert.equal(q, 'has:attachment label:"cgc-invoices" -label:"cgc-processed" -label:"cgc-review" after:2026/11/02');
  });

  it('keeps is:unread while no cutoff is set, so an upgrade cannot reach mail already read', () => {
    assert.equal(
      buildInboxQuery(config({ GMAIL_POLL_AFTER: undefined })),
      'has:attachment label:"cgc-invoices" -label:"cgc-processed" -label:"cgc-review" is:unread'
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
  // The review label is created alongside the processed one: the query
  // excludes both, so both must exist before the first search.
  it('creates the labels once when missing, then adds processed and marks the message read', async () => {
    const id = addMessage();
    await GmailService.pollInvoices(config());
    await GmailService.pollInvoices(config());

    assert.deepEqual(inboxCalls('labels.create').map(c => c.args.requestBody.name), ['cgc-processed', 'cgc-review']);
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

  it('without a cutoff nothing is read, opened or not', async () => {
    addMessage({ unread: false });
    addMessage();
    await GmailService.pollInvoices(config({ GMAIL_POLL_AFTER: undefined }));
    assert.equal(invoices.size, 0);
    assert.equal(inboxCalls('messages.list').length, 0);
  });

  it('a failed attachment leaves the message unlabelled, and the retry adds only what is missing', async () => {
    const id = addMessage({ attachments: [{ filename: 'a.pdf' }, { filename: 'b.pdf' }] });
    failIngestFor = `${id}:2`;
    await GmailService.pollInvoices(config());

    assert.deepEqual([...invoices.keys()], [`${id}:1`]);
    assert.ok(!labelsOf(id).includes('cgc-processed'));
    assert.equal(status().counts.failed, 1);

    // Tried again once the first retry delay has passed, not every minute.
    failIngestFor = null;
    clock += RETRY_BASE_MS;
    await GmailService.pollInvoices(config());
    assert.deepEqual([...invoices.keys()].sort(), [`${id}:1`, `${id}:2`]);
    assert.ok(labelsOf(id).includes('cgc-processed'));
    assert.equal(status().counts.duplicates, 1);
  });

  // This used to be labelled processed and forgotten. Nothing is dropped
  // without a trace now: it waits on the review queue with its reason.
  it('a message with only an unsupported file goes to review, not done', async () => {
    const id = addMessage({ attachments: [{ filename: 'notes.docx', mimeType: 'application/msword' }] });
    await GmailService.pollInvoices(config());
    assert.equal(invoices.size, 0);
    assert.ok(!labelsOf(id).includes('cgc-processed'));
    assert.ok(labelsOf(id).includes('cgc-review'));
    assert.equal(events.get(id).status, 'NEEDS_REVIEW');
    assert.equal(events.get(id).reviewReason, 'UNSUPPORTED_ATTACHMENTS');
    assert.equal(events.get(id).attachments[0].reason, ATTACHMENT_REASONS.unsupported);
    assert.equal(status().counts.needsReview, 1);
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
    invoices.set(`${id}:ANGjdJ8-legacyAttachmentIdFromTheOldPoller`, {
      id: 'inv-legacy', gmailMessageId: `${id}:ANGjdJ8-legacy`, fromEmail: SUPPLIER, subject: 'x', originalName: 'x.pdf',
    });

    await GmailService.pollInvoices(config());

    assert.equal(invoices.size, 1, 'no second invoice for the same email');
    assert.equal(inboxCalls('attachments.get').length, 0);
    assert.ok(labelsOf(id).includes('cgc-processed'));
    assert.equal(status().counts.legacySkipped, 1);
    assert.equal(events.get(id).status, 'PROCESSED');
    assert.deepEqual(events.get(id).createdInvoiceIds, ['inv-legacy']);
  });

  // The previous version keeps polling in a container a rollout has not
  // stopped yet. It keys by attachmentId, so the unique key cannot catch it:
  // what it wrote while this poll was sorting pages is looked for again
  // just before an invoice is created.
  it('an invoice the old poller made while this one was sorting pages is not made again', async () => {
    const id = addMessage();
    triageAnswer = () => {
      invoices.set(`${id}:ANGjdJ8-legacyAttachmentIdFromTheOldPoller`, {
        id: 'inv-legacy', gmailMessageId: `${id}:ANGjdJ8-legacy`, fromEmail: SUPPLIER, subject: 'x', originalName: 'x.pdf',
      });
      return ['invoice'];
    };
    await GmailService.pollInvoices(config());

    assert.deepEqual([...invoices.values()].map(i => i.id), ['inv-legacy'], 'no second invoice for the same email');
    assert.equal(status().counts.legacySkipped, 1);
    assert.equal(events.get(id).status, 'PROCESSED');
    assert.deepEqual(events.get(id).createdInvoiceIds, ['inv-legacy']);
    assert.ok(labelsOf(id).includes('cgc-processed'));
  });

  // Two pollers of this version (the API inline and the worker). The other
  // one filed the PDF while this one was sorting it: the Excel beside it is
  // still that invoice's breakdown, not a second invoice.
  it('losing the race on the PDF still keeps the Excel with the winner\'s invoice', async () => {
    const id = addMessage({ attachments: [
      { filename: 'invoice-90004.pdf' },
      { filename: 'invoice-90004-loads.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: await xlsxBytes() },
    ] });
    triageAnswer = (_bytes, mimeType) => {
      if (mimeType === 'application/pdf' && !invoices.has(`${id}:1`)) {
        invoices.set(`${id}:1`, { id: 'inv-other', gmailMessageId: `${id}:1`, fromEmail: SUPPLIER, subject: 'x', originalName: 'x.pdf' });
      }
      return ['invoice'];
    };
    await GmailService.pollInvoices(config());

    assert.deepEqual([...invoices.values()].map(i => i.id), ['inv-other'], 'one invoice from the email');
    assert.equal(supportingFiles.get(`${id}:2`)?.invoiceId, 'inv-other');
    assert.deepEqual(events.get(id).createdInvoiceIds, ['inv-other']);
    assert.equal(events.get(id).attachments[0].invoiceId, 'inv-other');
  });

  it('losing the race on the unique key itself names the winner\'s invoice too', async () => {
    const id = addMessage({ attachments: [
      { filename: 'invoice-90005.pdf' },
      { filename: 'invoice-90005-loads.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: await xlsxBytes() },
    ] });
    onIngest = (params) => {
      if (params.gmailMessageId === `${id}:1` && !invoices.has(`${id}:1`)) {
        invoices.set(`${id}:1`, { id: 'inv-winner', gmailMessageId: `${id}:1`, fromEmail: SUPPLIER, subject: 'x', originalName: 'x.pdf' });
      }
    };
    await GmailService.pollInvoices(config());

    assert.deepEqual([...invoices.values()].map(i => i.id), ['inv-winner']);
    assert.equal(supportingFiles.get(`${id}:2`)?.invoiceId, 'inv-winner');
    assert.deepEqual(events.get(id).createdInvoiceIds, ['inv-winner']);
    assert.equal(status().counts.duplicates, 1);
  });

  it('falls back to a content hash when Gmail reports no part id', async () => {
    const id = addMessage();
    delete mailbox.messages[0]!.payload.parts![1]!.partId;
    await GmailService.pollInvoices(config());
    const [key] = [...invoices.keys()];
    assert.match(key!, new RegExp(`^${id}:sha256-[0-9a-f]{32}$`));
  });
});

describe('one poller at a time', () => {
  // The API polls in-process unless WORKER_MODE=off, and the worker always
  // does. A lease in SystemSetting lets only one of them read the inbox.
  it('polls nothing while another process holds the inbox', async () => {
    addMessage();
    settings.set(POLL_LEASE_KEY, { holder: 'worker-elsewhere' });
    settingTimes.set(POLL_LEASE_KEY, new Date());
    await GmailService.pollInvoices(config());

    assert.equal(inboxCalls('messages.list').length, 0);
    assert.equal(invoices.size, 0);
    assert.equal(status(), undefined, 'the holder reports the poll, not this process');
  });

  it('takes over a lease its holder stopped renewing', async () => {
    addMessage();
    settings.set(POLL_LEASE_KEY, { holder: 'worker-that-died' });
    settingTimes.set(POLL_LEASE_KEY, new Date(Date.now() - POLL_LEASE_MS - 1000));
    await GmailService.pollInvoices(config());
    assert.equal(invoices.size, 1);
  });

  it('gives the lease back when the poll ends', async () => {
    addMessage();
    await GmailService.pollInvoices(config());
    assert.ok(settingTimes.get(POLL_LEASE_KEY)! < new Date(Date.now() - POLL_LEASE_MS));
  });
});

describe('an email that keeps failing', () => {
  // Every try downloads the attachment again and pays for a sorting call.
  // An error that recurs (a scan that times out, a file the reader always
  // chokes on) used to be retried every minute for ever, and never reached a
  // person.
  const failing = new Set<string>();
  beforeEach(() => {
    failing.clear();
    triageAnswer = (bytes) => ([...failing].some(id => bytes.toString().includes(id))
      ? new ExtractionError('no value matching the expected schema', { retryable: true })
      : ['invoice']);
  });

  it('is tried with growing gaps, then waits for a person with the reason', async () => {
    const id = addMessage();
    failing.add(id);

    await GmailService.pollInvoices(config());
    assert.equal(triageCalls.length, 1);
    assert.equal(events.get(id).status, 'FAILED');
    assert.match(events.get(id).errorMessage, /^Tried 1 time/);

    // A minute later: not tried, nothing downloaded or paid for.
    calls.length = 0;
    clock += MINUTE;
    await GmailService.pollInvoices(config());
    assert.equal(triageCalls.length, 1);
    assert.equal(inboxCalls('attachments.get').length, 0);
    assert.equal(status().counts.deferred, 1);

    for (let attempt = 2; attempt <= MAX_READ_ATTEMPTS; attempt += 1) {
      clock += retryDelayMs(attempt - 1);
      await GmailService.pollInvoices(config());
      assert.equal(triageCalls.length, attempt);
    }

    const event = events.get(id);
    assert.equal(event.status, 'NEEDS_REVIEW');
    assert.equal(event.reviewReason, 'READ_FAILED');
    assert.match(event.errorMessage, new RegExp(`Tried ${MAX_READ_ATTEMPTS} times.*expected schema`));
    assert.ok(labelsOf(id).includes('cgc-review'));
    assert.ok(!labelsOf(id).includes('cgc-processed'));
    assert.equal(event.attachments[0].action, 'review');

    // Off the query now: never tried again.
    clock += 24 * 60 * MINUTE;
    await GmailService.pollInvoices(config());
    assert.equal(triageCalls.length, MAX_READ_ATTEMPTS);
  });

  it('keeps what an earlier attachment made when it gives up', async () => {
    const id = addMessage({ attachments: [{ filename: 'a.pdf' }, { filename: 'b.pdf' }] });
    failIngestFor = `${id}:2`;
    for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt += 1) {
      await GmailService.pollInvoices(config());
      clock += retryDelayMs(attempt);
    }
    const event = events.get(id);
    assert.equal(event.reviewReason, 'READ_FAILED');
    assert.deepEqual(event.createdInvoiceIds, ['inv-1']);
    assert.deepEqual(event.attachments.map((a: any) => [a.name, a.action]), [['a.pdf', 'read'], ['b.pdf', 'review']]);
  });

  it('a success after a failure clears the count', async () => {
    const id = addMessage();
    failing.add(id);
    await GmailService.pollInvoices(config());
    failing.clear();
    clock += retryDelayMs(1);
    await GmailService.pollInvoices(config());
    assert.equal(events.get(id).status, 'PROCESSED');
    assert.equal(events.get(id).errorMessage, null);
  });

  it('approved emails that keep failing wait their turn and do not hold up later approvals', async () => {
    const stuck: string[] = [];
    for (let i = 0; i < PAGE_SIZE; i += 1) {
      const id = addMessage();
      failing.add(id);
      stuck.push(id);
      events.set(id, {
        gmailMessageId: id, status: 'NEEDS_REVIEW', reviewReason: 'UNKNOWN_SENDER', createdInvoiceIds: [],
        requeuedAt: new Date(clock - 60 * MINUTE + i), labelIds: [],
      });
    }
    await GmailService.pollInvoices(config());
    assert.equal(triageCalls.length, PAGE_SIZE);
    assert.ok(stuck.every(id => events.get(id).requeuedAt.getTime() > clock), 'each waits for its retry time');

    const later = addMessage();
    events.set(later, {
      gmailMessageId: later, status: 'NEEDS_REVIEW', reviewReason: 'UNKNOWN_SENDER', createdInvoiceIds: [], requeuedAt: new Date(clock),
    });
    clock += MINUTE;
    await GmailService.pollInvoices(config());
    assert.ok(invoices.has(`${later}:1`), 'the later approval is read');
    assert.equal(triageCalls.length, PAGE_SIZE + 1, 'the failing ones were not tried again yet');
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
    const [event] = [...events.values()];
    assert.equal(event.status, 'PROCESSED');
    assert.equal(event.originalFrom, SUPPLIER);
    assert.equal(event.forwardedBy, FORWARDER);
    assert.equal(event.senderMode, 'forward');
    assert.deepEqual(event.createdInvoiceIds, [invoice!.id]);
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
    assert.ok(labelsOf(id).includes('cgc-review'));
    assert.equal(events.get(id).reviewReason, 'UNRESOLVED_SENDER');
    assert.equal(events.get(id).originalFrom, null);
    assert.equal(status().counts.unresolvedSender, 1);
  });

  it('a forward naming an unknown supplier goes to review, and is not fetched again', async () => {
    addMessage({
      from: FORWARDER,
      extraHeaders: { 'Authentication-Results': AUTH_PASS },
      text: '-----Original Message-----\nFrom: someone@unknown-sender.test\nSent: Monday\nSubject: Hi\n',
    });
    await GmailService.pollInvoices(config());
    assert.equal(status().counts.rejectedSender, 1);
    // The review label keeps it out of the query: it was refused once, not
    // once a minute. (Before the queue, a per-process set did this until the
    // next deploy.)
    await GmailService.pollInvoices(config());

    assert.equal(invoices.size, 0);
    assert.equal(inboxCalls('messages.get').length, 1);
    assert.equal(inboxCalls('attachments.get').length, 0, 'nothing from an unknown sender is downloaded');
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
    // The census note has its own column now; errorMessage is for errors.
    const event = events.get(id);
    assert.equal(event.fromAddress, SUPPLIER);
    assert.equal(event.toAddress, INBOX);
    assert.equal(event.errorMessage, undefined);
    assert.match(event.note, /mode=forward/);
    assert.match(event.note, /forwardedBy=ap@garden-centre\.test/);
    assert.match(event.note, /known=no/);
    assert.match(event.note, /inv\.pdf \(application\/pdf\), detail\.xlsx/);
    assert.equal(event.originalFrom, SUPPLIER);
    assert.equal(event.senderMode, 'forward');
    // Unknown to the supplier records, so it shows on the review queue.
    assert.equal(event.status, 'NEEDS_REVIEW');
    assert.equal(event.reviewReason, 'UNKNOWN_SENDER');
    assert.deepEqual(event.attachments.map((a: any) => [a.name, a.action]), [['inv.pdf', 'held'], ['detail.xlsx', 'held']]);
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
    assert.match(events.get(id).note, /mode=unknown/);
    assert.equal(events.get(id).reviewReason, 'UNRESOLVED_SENDER');
  });
});

describe('known senders from the supplier records', () => {
  // No env allowlist: the supplier records alone decide.
  const records = () => config({ GMAIL_SENDER_ALLOWLIST: '' });
  const supplier = (over: Partial<(typeof suppliers)[number]>) => {
    suppliers.push({
      id: `sup-${suppliers.length + 1}`, name: 'Example Stone', type: 'SUPPLIER',
      emailDomains: [], emailAddresses: [], contactEmail: null, ...over,
    });
    return suppliers[suppliers.length - 1]!;
  };

  it('a supplier domain makes its senders known, and the event names the supplier', async () => {
    const s = supplier({ emailDomains: ['stone-supplier.test'] });
    const id = addMessage();
    await GmailService.pollInvoices(records());

    assert.equal(invoices.size, 1);
    assert.equal(events.get(id).status, 'PROCESSED');
    assert.equal(events.get(id).supplierId, s.id);
    assert.equal(events.get(id).senderTypeResolved, 'SUPPLIER');
    assert.ok(labelsOf(id).includes('cgc-processed'));
  });

  it('a trucking company is resolved as one', async () => {
    supplier({ type: 'TRUCKING_COMPANY', emailAddresses: [SUPPLIER] });
    const id = addMessage();
    await GmailService.pollInvoices(records());
    assert.equal(events.get(id).senderTypeResolved, 'TRUCKING_COMPANY');
  });

  it('an unknown sender is queued for review: an event, the review label, no invoice, nothing downloaded', async () => {
    supplier({ emailDomains: ['other-supplier.test'] });
    const id = addMessage({ from: 'Someone New <billing@new-supplier.test>' });
    await GmailService.pollInvoices(records());

    assert.equal(invoices.size, 0);
    assert.equal(inboxCalls('attachments.get').length, 0);
    const event = events.get(id);
    assert.equal(event.status, 'NEEDS_REVIEW');
    assert.equal(event.reviewReason, 'UNKNOWN_SENDER');
    assert.equal(event.originalFrom, 'billing@new-supplier.test');
    assert.equal(event.senderMode, 'direct');
    assert.equal(event.supplierId, null);
    assert.deepEqual(event.attachments, [{
      name: 'invoice-90001.pdf', mimeType: 'application/pdf', size: null, partId: '1',
      kind: 'pdf', action: 'held', reason: ATTACHMENT_REASONS.held,
    }]);
    assert.ok(labelsOf(id).includes('cgc-review'));
    assert.ok(labelsOf(id).includes('UNREAD'), 'AP still sees it unread');
    assert.ok(!labelsOf(id).includes('cgc-processed'));
  });

  it('a free-mail domain on a supplier identifies nobody; an exact free-mail address does', async () => {
    supplier({ name: 'Old Record', emailDomains: ['gmail.com'] });
    supplier({ name: 'Owner Operator', type: 'TRUCKING_COMPANY', emailAddresses: ['owner.operator@gmail.com'] });
    const stranger = addMessage({ from: 'stranger@gmail.com' });
    const operator = addMessage({ from: 'Owner Operator <Owner.Operator@gmail.com>' });
    await GmailService.pollInvoices(records());

    assert.equal(events.get(stranger).status, 'NEEDS_REVIEW');
    assert.equal(events.get(operator).status, 'PROCESSED');
    assert.equal(events.get(operator).supplierId, 'sup-2');
    assert.deepEqual([...invoices.values()].map(i => i.fromEmail), ['owner.operator@gmail.com']);
  });

  it('the env allowlist still makes a sender known when no supplier names it', async () => {
    const id = addMessage();
    await GmailService.pollInvoices(config());
    assert.equal(events.get(id).status, 'PROCESSED');
    assert.equal(events.get(id).supplierId, null);
    assert.equal(events.get(id).senderTypeResolved, 'UNKNOWN');
  });

  it('approving the sender re-queues its email: read on the next poll and moved off the review label', async () => {
    const id = addMessage({ from: 'billing@new-supplier.test' });
    await GmailService.pollInvoices(records());
    assert.equal(events.get(id).status, 'NEEDS_REVIEW');

    // What POST /api/email-events/:id/approve leaves behind (its own test is
    // tests/emailReviewQueue.integration.test.ts). The approval runs in the
    // API process, so this process's cached sender list is not cleared: the
    // poller must read the supplier records afresh by itself.
    supplier({ emailAddresses: ['billing@new-supplier.test'] });
    events.set(id, { ...events.get(id), requeuedAt: new Date(clock), reviewedById: 'user-1' });
    calls.length = 0;
    await GmailService.pollInvoices(records());

    assert.equal(invoices.size, 1);
    assert.deepEqual(inboxCalls('messages.get').map(c => c.args.id), [id], 'fetched by id, once');
    const event = events.get(id);
    assert.equal(event.status, 'PROCESSED');
    assert.equal(event.requeuedAt, null);
    assert.equal(event.supplierId, 'sup-1');
    assert.equal(event.reviewedById, 'user-1', 'who approved it stays on record');
    assert.ok(labelsOf(id).includes('cgc-processed'));
    assert.ok(!labelsOf(id).includes('cgc-review'));
    assert.equal(status().counts.requeued, 1);

    await GmailService.pollInvoices(records());
    assert.equal(invoices.size, 1, 'read once');
  });

  // Runbook step 6: moving GMAIL_POLL_AFTER to today skips the census
  // period, which AP entered by hand. An email queued then and approved now
  // is fetched by id, not by the query, so the date is checked here too.
  it('an approved email from before GMAIL_POLL_AFTER is not read; it waits for a person', async () => {
    const id = addMessage({ from: 'billing@new-supplier.test', receivedAt: new Date('2026-10-20T15:00:00Z') });
    // The census row observe mode wrote for it, now approved.
    events.set(id, {
      gmailMessageId: id, status: 'NEEDS_REVIEW', reviewReason: 'UNKNOWN_SENDER', createdInvoiceIds: [], requeuedAt: new Date(clock),
    });
    supplier({ emailAddresses: ['billing@new-supplier.test'] });
    calls.length = 0;
    await GmailService.pollInvoices(records());

    assert.equal(invoices.size, 0);
    assert.equal(inboxCalls('attachments.get').length, 0, 'nothing downloaded');
    const event = events.get(id);
    assert.equal(event.status, 'NEEDS_REVIEW');
    assert.equal(event.reviewReason, 'BEFORE_CUTOFF');
    assert.equal(event.requeuedAt, null);
    assert.ok(labelsOf(id).includes('cgc-review'));
    assert.ok(!labelsOf(id).includes('cgc-processed'));
  });

  it('observe mode leaves approved mail for ingest mode', async () => {
    const id = addMessage({ from: 'billing@new-supplier.test' });
    await GmailService.pollInvoices(records());
    events.set(id, { ...events.get(id), requeuedAt: new Date(clock) });
    await GmailService.pollInvoices(config({ GMAIL_INGEST_MODE: 'observe', GMAIL_SENDER_ALLOWLIST: '' }));
    assert.equal(invoices.size, 0);
    assert.notEqual(events.get(id).requeuedAt, null);
  });

  it('approved mail deleted from Gmail meanwhile is marked failed, not retried every minute', async () => {
    const id = addMessage({ from: 'billing@new-supplier.test' });
    await GmailService.pollInvoices(records());
    events.set(id, { ...events.get(id), requeuedAt: new Date(clock) });
    mailbox.messages = [];
    await GmailService.pollInvoices(records());

    assert.equal(events.get(id).status, 'FAILED');
    assert.equal(events.get(id).requeuedAt, null);
    assert.match(events.get(id).errorMessage, /no longer in the Gmail inbox/);
  });

  it('an ignored email that comes back to the query is put back on the review label', async () => {
    const id = addMessage();
    events.set(id, { gmailMessageId: id, status: 'IGNORED', createdInvoiceIds: [], requeuedAt: null });
    await GmailService.pollInvoices(config());
    assert.equal(invoices.size, 0);
    assert.ok(labelsOf(id).includes('cgc-review'));
    assert.equal(events.get(id).status, 'IGNORED');
  });
});

/** A small workbook built here, so no client file is involved. */
async function xlsxBytes(): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Invoice');
  sheet.addRow(['Invoice', 'INV-90002']);
  sheet.addRow(['Item', 'Qty', 'Unit', 'Price']);
  sheet.addRow(['Screened sand', 12, 't', 31.5]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('attachment selection', () => {
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const png = (bytes: number) => Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(bytes),
  ]);

  it('an .xlsx invoice on its own is read: sorted as text, stored as .xlsx, the email done', async () => {
    const id = addMessage({ attachments: [{ filename: 'invoice-90002.xlsx', mimeType: XLSX_MIME, content: await xlsxBytes() }] });
    await GmailService.pollInvoices(config());

    const invoice = invoices.get(`${id}:1`);
    assert.ok(invoice, 'the workbook became an invoice');
    assert.equal(invoice.originalName, 'invoice-90002.xlsx');
    assert.deepEqual(triageCalls, [{ mimeType: XLSX_MIME, filename: 'invoice-90002.xlsx' }]);
    const event = events.get(id);
    assert.equal(event.status, 'PROCESSED');
    assert.equal(event.attachments[0].kind, 'spreadsheet');
    assert.equal(event.attachments[0].action, 'read');
    assert.equal(event.attachments[0].invoiceId, invoice.id);
    assert.ok(labelsOf(id).includes('cgc-processed'));
  });

  it('a CSV invoice is read the same way, even when Windows calls it an Excel file', async () => {
    const id = addMessage({ attachments: [{
      filename: 'invoice-90006.csv', mimeType: 'application/vnd.ms-excel',
      content: Buffer.from('Item,Qty,Unit,Price\nScreened sand,12,t,31.50\n'),
    }] });
    await GmailService.pollInvoices(config());
    assert.equal(invoices.get(`${id}:1`)?.originalName, 'invoice-90006.csv');
    assert.equal(triageCalls[0]?.mimeType, 'text/csv');
    assert.equal(events.get(id).status, 'PROCESSED');
  });

  it('an old .xls waits for a person with the reason, and nothing is read from it', async () => {
    const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
    const id = addMessage({ attachments: [{ filename: 'invoice-90007.xls', mimeType: 'application/vnd.ms-excel', content: OLE }] });
    await GmailService.pollInvoices(config());

    assert.equal(invoices.size, 0);
    assert.equal(triageCalls.length, 0);
    const event = events.get(id);
    assert.equal(event.status, 'NEEDS_REVIEW');
    assert.equal(event.reviewReason, 'SPREADSHEET');
    assert.equal(event.attachments[0].reason, ATTACHMENT_REASONS.legacyXls);
    assert.match(event.attachments[0].reason, /old Excel format \(\.xls\): ask the supplier for PDF or \.xlsx/);
    assert.ok(labelsOf(id).includes('cgc-review'));
    assert.ok(!labelsOf(id).includes('cgc-processed'));
  });

  it('an Excel beside a PDF invoice is kept with that invoice, not read as a second one', async () => {
    const id = addMessage({ attachments: [
      { filename: 'invoice-90003.pdf' },
      { filename: 'invoice-90003-detail.xlsx', mimeType: XLSX_MIME, content: await xlsxBytes() },
    ] });
    await GmailService.pollInvoices(config());

    assert.deepEqual([...invoices.keys()], [`${id}:1`]);
    assert.equal(triageCalls.length, 1, 'only the PDF is sorted');
    const file = supportingFiles.get(`${id}:2`);
    assert.equal(file?.invoiceId, 'inv-1');
    assert.equal(file?.originalName, 'invoice-90003-detail.xlsx');
    const event = events.get(id);
    assert.equal(event.status, 'PROCESSED');
    assert.deepEqual(event.createdInvoiceIds, ['inv-1']);
    assert.deepEqual(event.attachments.map((a: any) => [a.name, a.action, a.invoiceId ?? a.supportingInvoiceId ?? null, a.reason]), [
      ['invoice-90003.pdf', 'read', 'inv-1', null],
      ['invoice-90003-detail.xlsx', 'read', 'inv-1', ATTACHMENT_REASONS.supportingFile],
    ]);
    assert.ok(labelsOf(id).includes('cgc-processed'));
    assert.equal(status().counts.supportingFiles, 1);

    // Read again (its label removed by hand): nothing new is made.
    mailbox.messages[0]!.labelIds = mailbox.messages[0]!.labelIds.filter(l => l !== labelId('cgc-processed'));
    await GmailService.pollInvoices(config());
    assert.equal(invoices.size, 1);
    assert.equal(supportingFiles.size, 1);
  });

  it('a second invoice sent as an iPhone photo keeps the email on the review queue, beside the one that was read', async () => {
    const id = addMessage({ attachments: [
      { filename: 'invoice-90006.pdf' },
      { filename: 'invoice-90007.heic', mimeType: 'image/heic', size: 900_000 },
    ] });
    await GmailService.pollInvoices(config());

    assert.deepEqual([...invoices.keys()], [`${id}:1`], 'the PDF is still read');
    const event = events.get(id);
    assert.equal(event.status, 'NEEDS_REVIEW');
    assert.equal(event.reviewReason, 'PARTLY_READ');
    assert.deepEqual(event.createdInvoiceIds, ['inv-1']);
    assert.equal(event.attachments[1].reason, ATTACHMENT_REASONS.heic);
    assert.ok(labelsOf(id).includes('cgc-review'));
    assert.ok(!labelsOf(id).includes('cgc-processed'));
    assert.equal(status().counts.needsReview, 1);
  });

  it('an inline signature logo is skipped and listed; the PDF is the only invoice', async () => {
    const id = addMessage({ attachments: [
      { filename: 'invoice-90004.pdf' },
      {
        filename: 'image001.png', mimeType: 'image/png', size: 4_200,
        headers: [{ name: 'Content-ID', value: '<image001.png@01DA0000.00000000>' }, { name: 'Content-Disposition', value: 'inline; filename="image001.png"' }],
      },
    ] });
    await GmailService.pollInvoices(config());

    assert.deepEqual([...invoices.keys()], [`${id}:1`]);
    assert.equal(inboxCalls('attachments.get').length, 1, 'the logo is not even downloaded');
    const logo = events.get(id).attachments[1];
    assert.equal(logo.action, 'skipped');
    assert.equal(logo.reason, ATTACHMENT_REASONS.inline);
    assert.equal(events.get(id).status, 'PROCESSED');
    assert.ok(labelsOf(id).includes('cgc-processed'));
  });

  it('a large inline image (a photo pasted into the email) is still read', async () => {
    const id = addMessage({ attachments: [{
      filename: 'IMG_0042.png', mimeType: 'image/png', size: 900_000, content: png(20_000),
      headers: [{ name: 'Content-ID', value: '<photo-1>' }],
    }] });
    await GmailService.pollInvoices(config());
    assert.ok(invoices.has(`${id}:1`));
  });

  it('a PDF without an extension or a useful type is read, and stored with .pdf', async () => {
    const id = addMessage({ attachments: [{ filename: 'Invoice 90005', mimeType: 'application/octet-stream' }] });
    await GmailService.pollInvoices(config());

    const invoice = invoices.get(`${id}:1`);
    assert.ok(invoice, 'the PDF became an invoice');
    assert.equal(invoice.originalName, 'Invoice_90005.pdf');
    assert.equal(events.get(id).attachments[0].kind, 'pdf');
  });

  it('a file named .pdf that is not a PDF is not read, and the email goes to review', async () => {
    const id = addMessage({ attachments: [{ filename: 'invoice.pdf', content: Buffer.from('<html>phish</html>') }] });
    await GmailService.pollInvoices(config());

    assert.equal(invoices.size, 0);
    assert.equal(events.get(id).reviewReason, 'UNSUPPORTED_ATTACHMENTS');
    assert.equal(events.get(id).attachments[0].reason, ATTACHMENT_REASONS.mismatch);
  });

  it('an email with nothing but a logo goes to review instead of vanishing', async () => {
    const id = addMessage({ attachments: [{
      filename: 'image001.png', mimeType: 'image/png', size: 3_000,
      headers: [{ name: 'Content-ID', value: '<image001.png@x>' }],
    }] });
    await GmailService.pollInvoices(config());
    assert.equal(events.get(id).status, 'NEEDS_REVIEW');
    assert.equal(events.get(id).reviewReason, 'NO_INVOICE_ATTACHMENT');
    assert.equal(status().counts.noAttachments, 1);
  });
});

const { PDFDocument } = await import('pdf-lib');

describe('sorting pages before anything is created (A15)', () => {
  /** A PDF with one page per label, each page printing its label. */
  async function pdfWith(labels: string[]): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    for (const label of labels) pdf.addPage([300, 200]).drawText(label, { x: 20, y: 100, size: 12 });
    return Buffer.from(await pdf.save());
  }
  const pagesOf = async (bytes: Buffer | undefined) => (await PDFDocument.load(bytes!)).getPageCount();
  const supplier = () => {
    suppliers.push({
      id: 'sup-stone', name: 'Example Stone', type: 'SUPPLIER',
      emailDomains: ['stone-supplier.test'], emailAddresses: [], contactEmail: null,
    });
  };

  it('invoice pages become one invoice; each ticket page becomes an emailed ticket under the original supplier', async () => {
    supplier();
    triageAnswer = () => ['invoice', 'delivery_ticket', 'invoice', 'delivery_ticket'];
    const id = addMessage({
      from: `Accounts Payable <${FORWARDER}>`,
      extraHeaders: { 'Authentication-Results': AUTH_PASS },
      text: `-----Original Message-----\nFrom: Stone Supplier <${SUPPLIER}>\nSent: Monday\nSubject: Invoice 90010\n`,
      attachments: [{ filename: 'invoice-90010.pdf', content: await pdfWith(['INV p1', 'TICKET 501', 'INV p2', 'TICKET 502']) }],
    });
    await GmailService.pollInvoices(config({ GMAIL_SENDER_ALLOWLIST: '' }));

    const invoice = invoices.get(`${id}:1`);
    assert.ok(invoice);
    assert.equal(await pagesOf(invoice.buffer), 2, 'only the invoice pages');
    assert.equal(invoice.fromEmail, SUPPLIER);

    assert.deepEqual([...tickets.keys()], [`${id}:1#2`, `${id}:1#4`]);
    for (const ticket of tickets.values()) {
      assert.equal(await pagesOf(ticket.buffer), 1, 'one page per ticket');
      assert.equal(ticket.fromEmail, SUPPLIER, 'the supplier, not the AP mailbox');
      assert.equal(ticket.supplierId, 'sup-stone');
    }
    assert.equal(tickets.get(`${id}:1#2`)!.originalName, 'invoice-90010-p2.pdf');

    const event = events.get(id);
    assert.equal(event.status, 'PROCESSED');
    assert.deepEqual(event.createdInvoiceIds, [invoice.id]);
    assert.deepEqual(event.createdTicketIds, ['ticket-1', 'ticket-2']);
    assert.deepEqual(event.attachments[0].ticketIds, ['ticket-1', 'ticket-2']);
    assert.equal(event.attachments[0].reason, 'pages 1, 3 invoice; pages 2, 4 delivery tickets');
    assert.equal(status().counts.ticketsCreated, 2);
    assert.equal(status().counts.invoicesCreated, 1);
  });

  it('a separate ticket photo beside the invoice becomes a ticket, not a second invoice', async () => {
    const photo = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20_000)]);
    triageAnswer = (_bytes, mimeType) => (mimeType === 'image/png' ? ['delivery_ticket'] : ['invoice']);
    const id = addMessage({ attachments: [
      { filename: 'invoice-90011.pdf' },
      { filename: 'ticket-503.png', mimeType: 'image/png', content: photo },
    ] });
    await GmailService.pollInvoices(config());

    assert.deepEqual([...invoices.keys()], [`${id}:1`]);
    assert.deepEqual([...tickets.keys()], [`${id}:2#1`]);
    assert.equal(events.get(id).attachments[1].reason, ATTACHMENT_REASONS.ticketFiled);
    assert.equal(events.get(id).status, 'PROCESSED');
  });

  it('a spreadsheet of loads on its own is not filed as a ticket and waits for a person, saying so', async () => {
    triageAnswer = () => ['delivery_ticket'];
    const id = addMessage({ attachments: [{
      filename: 'loads-oct.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: await xlsxBytes(),
    }] });
    await GmailService.pollInvoices(config());

    assert.equal(invoices.size, 0);
    assert.equal(tickets.size, 0);
    const event = events.get(id);
    assert.equal(event.status, 'NEEDS_REVIEW');
    assert.equal(event.attachments[0].action, 'skipped');
    assert.equal(event.attachments[0].reason, ATTACHMENT_REASONS.sheetOfLoads);
  });

  it('a statement is recorded on the email and never becomes an invoice', async () => {
    triageAnswer = () => ['statement', 'statement'];
    const id = addMessage({ attachments: [{ filename: 'statement-oct.pdf', content: await pdfWith(['Statement p1', 'Statement p2']) }] });
    await GmailService.pollInvoices(config());

    assert.equal(invoices.size, 0);
    assert.equal(tickets.size, 0);
    const event = events.get(id);
    assert.equal(event.status, 'PROCESSED');
    assert.equal(event.attachments[0].action, 'skipped');
    assert.deepEqual(event.attachments[0].pages, [{ page: 1, kind: 'statement' }, { page: 2, kind: 'statement' }]);
    assert.equal(event.attachments[0].reason, 'pages 1-2 statement (not billed)');
    assert.ok(labelsOf(id).includes('cgc-processed'));
  });

  it('a credit memo is recorded and waits for a person', async () => {
    triageAnswer = () => ['credit_memo'];
    const id = addMessage({ attachments: [{ filename: 'credit-77.pdf' }] });
    await GmailService.pollInvoices(config());

    assert.equal(invoices.size, 0);
    assert.equal(events.get(id).status, 'NEEDS_REVIEW');
    assert.equal(events.get(id).reviewReason, 'CREDIT_MEMO');
    assert.equal(events.get(id).attachments[0].reason, ATTACHMENT_REASONS.creditMemo);
    assert.ok(labelsOf(id).includes('cgc-review'));
  });

  it('an outage while sorting creates nothing and leaves the email for the next poll', async () => {
    triageAnswer = () => new ExtractionError('rate limited', { retryable: true });
    const id = addMessage();
    await GmailService.pollInvoices(config());
    assert.equal(invoices.size, 0);
    assert.equal(status().counts.failed, 1);
    assert.ok(!labelsOf(id).includes('cgc-processed'));

    triageAnswer = () => ['invoice'];
    clock += RETRY_BASE_MS;
    await GmailService.pollInvoices(config());
    assert.ok(invoices.has(`${id}:1`));
  });

  it('a file the sorter refuses for good is read whole as an invoice, as before, and says so', async () => {
    triageAnswer = () => new ExtractionError('refused', { retryable: false });
    const id = addMessage();
    await GmailService.pollInvoices(config());
    assert.ok(invoices.has(`${id}:1`));
    assert.equal(events.get(id).attachments[0].reason, ATTACHMENT_REASONS.sortFailed);
  });

  // An owner-password PDF from a billing system, or one too long to split:
  // the file used to be filed as one ticket, which is page 1 only, and the
  // other tickets were lost with the email marked processed.
  async function encryptedPdfWith(labels: string[]): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    for (const label of labels) pdf.addPage([300, 200]).drawText(label, { x: 20, y: 100, size: 12 });
    pdf.context.trailerInfo.Encrypt = pdf.context.register(pdf.context.obj({ Filter: 'Standard', V: 1, R: 2, P: -4 }));
    return Buffer.from(await pdf.save({ useObjectStreams: false }));
  }

  it('several tickets in a file that cannot be split wait for a person; none is filed from page 1 alone', async () => {
    triageAnswer = () => ['delivery_ticket', 'delivery_ticket', 'delivery_ticket'];
    const id = addMessage({ attachments: [{ filename: 'tickets-oct.pdf', content: await encryptedPdfWith(['T 601', 'T 602', 'T 603']) }] });
    await GmailService.pollInvoices(config());

    assert.equal(tickets.size, 0);
    assert.equal(invoices.size, 0);
    const event = events.get(id);
    assert.equal(event.status, 'NEEDS_REVIEW');
    assert.equal(event.reviewReason, 'TICKETS_NOT_SPLIT');
    assert.equal(event.attachments[0].action, 'review');
    assert.equal(event.attachments[0].reason, ATTACHMENT_REASONS.ticketsNotSplit);
    assert.ok(labelsOf(id).includes('cgc-review'));
  });

  it('a damaged multi-page file the sorter calls tickets waits for a person too', async () => {
    // The default attachment is not a PDF pdf-lib can open: no page count.
    triageAnswer = () => ['delivery_ticket', 'delivery_ticket'];
    const id = addMessage();
    await GmailService.pollInvoices(config());
    assert.equal(tickets.size, 0);
    assert.equal(events.get(id).reviewReason, 'TICKETS_NOT_SPLIT');
  });

  it('an invoice with tickets behind it that cannot be split is read whole; the tickets wait for a person', async () => {
    triageAnswer = () => ['invoice', 'delivery_ticket', 'delivery_ticket'];
    const id = addMessage({ attachments: [{ filename: 'invoice-90020.pdf', content: await encryptedPdfWith(['INV', 'T 701', 'T 702']) }] });
    await GmailService.pollInvoices(config());

    assert.deepEqual([...invoices.keys()], [`${id}:1`]);
    assert.equal(tickets.size, 0);
    const event = events.get(id);
    assert.equal(event.reviewReason, 'PARTLY_READ');
    assert.equal(event.attachments[0].invoiceId, 'inv-1');
    assert.equal(event.attachments[0].reason, ATTACHMENT_REASONS.ticketsNotSplit);
  });

  it('a one-page ticket that cannot be opened is still filed as one ticket', async () => {
    triageAnswer = () => ['delivery_ticket'];
    addMessage();
    await GmailService.pollInvoices(config());
    assert.equal(tickets.size, 1);
  });

  it('a retried email never files the same ticket page twice', async () => {
    triageAnswer = () => ['invoice', 'delivery_ticket'];
    const id = addMessage({ attachments: [{ filename: 'invoice-90012.pdf', content: await pdfWith(['INV', 'TICKET 504']) }] });
    failIngestFor = `${id}:1`;
    await GmailService.pollInvoices(config());
    assert.equal(tickets.size, 1, 'the ticket was filed before the invoice failed');
    assert.equal(invoices.size, 0);

    failIngestFor = null;
    clock += RETRY_BASE_MS;
    await GmailService.pollInvoices(config());
    assert.equal(tickets.size, 1);
    assert.equal(invoices.size, 1);
    assert.deepEqual(events.get(id).createdTicketIds, ['ticket-1']);
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
