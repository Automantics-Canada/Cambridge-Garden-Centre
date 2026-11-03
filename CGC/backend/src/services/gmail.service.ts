import { createHash } from 'node:crypto';
import { google, type gmail_v1 } from 'googleapis';
import { env } from '../config/env.js';
import {
  buildInboxQuery,
  gmailPollDisabledReason,
  readCutoff,
  type GmailInboxConfig,
} from '../config/gmailConfig.js';
import { InvoiceService } from '../modules/invoices/invoice.service.js';
import { TicketService } from '../modules/tickets/ticket.service.js';
import { prisma } from '../db/prisma.js';
import { triggerOcrProcessing } from './ocrJobProcessor.js';
import {
  headerValues,
  parseAddress,
  resolveSender,
  type ResolvedSender,
} from './emailSender.js';
import { invalidateKnownSenders, knownSenders, lookupSender, type SenderLookup } from './knownSenders.js';
import {
  ATTACHMENT_REASONS,
  attachmentReviewReason,
  classifyDownloaded,
  heldRecords,
  storedFileName,
  triageAttachments,
  type AttachmentRecord,
  type ReviewReason,
} from './emailAttachments.js';
import { EmailIngestionStatus, SenderTypeResolved, type Prisma } from '@prisma/client';
import {
  CSV_MIME_TYPE,
  ExtractionError,
  triageDocument,
  XLSX_MIME_TYPE,
} from './extraction/extraction.service.js';
import type { DocumentTriage } from './extraction/schemas.js';
import { describePages, planPages, unsortedPlan, type PagePlan } from './emailTriage.js';
import { extractPdfPages, inspectPdf, MAX_SPLIT_PAGES } from '../lib/pdfPages.js';
import { detectFileKind } from '../middleware/uploadValidation.js';
import { detectSpreadsheetKind } from '../lib/spreadsheet.js';
import {
  acquirePollLease,
  LEASE_HOLDER,
  POLL_LEASE_RENEW_MS,
  releasePollLease,
  renewPollLease,
} from './gmailLease.js';
import {
  describeError,
  emptyCounts,
  maskAddress,
  writeGmailStatus,
  type GmailPollCounts,
  type GmailPollStatus,
} from './gmailStatus.js';

/**
 * The redirect URI the refresh tokens were issued against. Tokens come from
 * the OAuth Playground (docs/gmail-mailbox-switch.md), so it must stay this.
 */
export const OAUTH_REDIRECT_URI = 'https://developers.google.com/oauthplayground';

/** Messages per page and pages per poll: at most 100 messages a minute. */
export const PAGE_SIZE = 25;
export const MAX_PAGES = 4;

/**
 * Retrying an email that failed. Every try downloads its attachments again
 * and pays for a sorting call, and some errors recur (a scan that times out,
 * a file the reader always refuses), so an email is tried at most this many
 * times, with a growing gap between tries: 5, 10, 20, 40 and 80 minutes,
 * which rides out an outage of a couple of hours. Then it waits in the
 * review queue with the error, for a person.
 */
export const MAX_READ_ATTEMPTS = 6;
export const RETRY_BASE_MS = 5 * 60 * 1000;
const RETRY_MAX_MS = 2 * 60 * 60 * 1000;

/** How long to wait before the next try, after this many failed ones. */
export function retryDelayMs(failures: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), RETRY_MAX_MS);
}

/**
 * The failure line kept in `EmailIngestionEvent.errorMessage`. It is the
 * count and time of the last try as well as the error, read back by
 * readFailure, so the count survives a restart without a column of its own.
 */
export function failureNote(attempts: number, at: Date, message: string): string {
  return `Tried ${attempts} time${attempts === 1 ? '' : 's'}; last try ${at.toISOString()}: ${message}`.slice(0, 1000);
}

/** The count and time from a failureNote, or null for any other text. */
export function readFailure(errorMessage: string | null | undefined): { attempts: number; at: Date } | null {
  const match = /^Tried (\d+) times?; last try (\S+): /.exec(errorMessage ?? '');
  if (!match) return null;
  const at = new Date(match[2]!);
  return Number.isNaN(at.getTime()) ? null : { attempts: Number(match[1]), at };
}

type Part = gmail_v1.Schema$MessagePart;

/** The label ids a poll applies: `done` (processed or observed) and `review`. */
interface PollLabels {
  done: string;
  review: string;
}

/** Every part of a message, depth first. */
function allParts(payload: Part | undefined): Part[] {
  if (!payload) return [];
  return [payload, ...(payload.parts ?? []).flatMap(allParts)];
}

/** The first plain-text and HTML bodies, decoded, for reading a forwarded header block. */
export function messageBody(payload: Part | undefined): { text: string | null; html: string | null } {
  let text: string | null = null;
  let html: string | null = null;
  for (const part of allParts(payload)) {
    if (part.filename || !part.body?.data) continue;
    const decoded = Buffer.from(part.body.data, 'base64url').toString('utf8');
    if (part.mimeType === 'text/plain' && text === null) text = decoded;
    if (part.mimeType === 'text/html' && html === null) html = decoded;
  }
  return { text, html };
}

/**
 * True for an `Invoice.gmailMessageId` suffix written by this version:
 * a MIME part id (`1`, `0.2`) or a content hash. Anything else after the
 * message id is the previous poller's attachmentId.
 */
function isCurrentKeySuffix(suffix: string): boolean {
  return /^\d+(\.\d+)*$/.test(suffix) || suffix.startsWith('sha256-');
}

/**
 * The idempotency key of one attachment: `messageId:partId`.
 *
 * The previous key used the attachmentId, which Google does not document as
 * stable across fetches of the same message. The part id is the attachment's
 * position in the message's MIME tree, which cannot change. A content hash
 * stands in when Gmail reports no part id.
 */
export function attachmentKey(messageId: string, part: Part, bytes?: Buffer): string | null {
  if (part.partId) return `${messageId}:${part.partId}`;
  if (!bytes) return null;
  return `${messageId}:sha256-${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`;
}

/**
 * One line describing a message for the observe-mode census, stored in
 * `EmailIngestionEvent.note`. The same facts have their own columns; the line
 * keeps the census readable in one SQL query.
 */
export function censusNote(sender: ResolvedSender, known: boolean, attachments: readonly AttachmentRecord[]): string {
  const files = attachments.length === 0
    ? 'none'
    : attachments.map(a => `${a.name || '(no name)'} (${a.mimeType ?? 'unknown type'})`).join(', ');
  return [
    'observe',
    `mode=${sender.mode}`,
    `forwardedBy=${sender.forwardedBy ?? '-'}`,
    `known=${known ? 'yes' : 'no'}`,
    `reason=${sender.reason}`,
    `attachments: ${files}`,
  ].join('; ').slice(0, 2000);
}

/** What happened to a message, as one of the per-message counters. */
type Outcome = Exclude<
  keyof GmailPollCounts,
  'listed' | 'invoicesCreated' | 'ticketsCreated' | 'supportingFiles' | 'duplicates' | 'requeued'
>;

/** Reads what each page of an attachment is. Replaced by the tests. */
type Triage = (bytes: Buffer, mimeType: string, filename: string) => Promise<DocumentTriage>;

const IMAGE_MIME_BY_LABEL: Record<string, string> = {
  PNG: 'image/png', JPEG: 'image/jpeg', GIF: 'image/gif', WebP: 'image/webp',
};

/** The content type the reader is told, from the bytes (and, for a CSV, the classification). */
function readableMimeType(record: AttachmentRecord, bytes: Buffer): string {
  const detected = detectFileKind(bytes);
  if (detected?.kind === 'pdf') return 'application/pdf';
  if (detected?.kind === 'image') return IMAGE_MIME_BY_LABEL[detected.label] ?? 'image/jpeg';
  return detectSpreadsheetKind(bytes, record.name || undefined) === 'xlsx' ? XLSX_MIME_TYPE : CSV_MIME_TYPE;
}

/** The reason recorded for a one-page file that is not an invoice. */
const REASON_BY_KIND = {
  delivery_ticket: ATTACHMENT_REASONS.ticketFiled,
  statement: ATTACHMENT_REASONS.statement,
  credit_memo: ATTACHMENT_REASONS.creditMemo,
  other: ATTACHMENT_REASONS.notInvoice,
} as const;

/** "invoice-77.pdf" page 3 → "invoice-77-p3.pdf". */
function pageFileName(name: string, page: number): string {
  const base = (name || 'ticket').replace(/\.[a-z0-9]+$/i, '');
  return `${base}-p${page}.pdf`;
}

/** Everything one email's attachments produced, for its mailbox-log row. */
interface ReadOutcome {
  records: AttachmentRecord[];
  createdInvoiceIds: string[];
  createdTicketIds: string[];
}

/** What the mailbox log row for a message says. */
interface EventFields {
  status: EmailIngestionStatus;
  reviewReason: ReviewReason | null;
  subject: string;
  fromAddress: string;
  toAddress: string;
  originalFrom: string | null;
  forwardedBy: string | null;
  senderMode: string;
  supplierId: string | null;
  senderTypeResolved: SenderTypeResolved;
  attachments: AttachmentRecord[];
  createdInvoiceIds: string[];
  createdTicketIds?: string[];
  note: string | null;
  /** Default null: writing the event clears an earlier failure. */
  errorMessage?: string | null;
  /** Default null: writing the event clears a pending re-queue. */
  requeuedAt?: Date | null;
}

type ExistingEvent = {
  status: EmailIngestionStatus;
  createdInvoiceIds: string[];
  createdTicketIds?: string[];
  requeuedAt: Date | null;
  errorMessage?: string | null;
} | null;

/** The facts about one fetched message that every path below needs. */
interface MessageFacts {
  messageId: string;
  payload: Part | undefined;
  subject: string;
  rawFrom: string;
  toAddress: string;
  receivedAt: Date;
  sender: ResolvedSender;
  lookup: SenderLookup;
  existing: ExistingEvent;
}

function senderTypeResolved(lookup: SenderLookup): SenderTypeResolved {
  if (!lookup.supplier) return SenderTypeResolved.UNKNOWN;
  return lookup.supplier.type === 'TRUCKING_COMPANY' ? SenderTypeResolved.TRUCKING_COMPANY : SenderTypeResolved.SUPPLIER;
}

/** The lookup for a message whose sender could not be established. */
const NOBODY: SenderLookup = { known: false, supplier: null, matchedBy: null, ambiguous: false };

/** Gmail's 404 for a message that is no longer in the mailbox. */
function isNotFound(error: unknown): boolean {
  const e = error as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
  return e?.code === 404 || e?.status === 404 || e?.response?.status === 404;
}

/**
 * The previous poller ingested this email while this one was reading it (a
 * rollout runs both for a moment). Thrown from deep in the attachment loop,
 * caught where the message is handled, which then skips it as it would any
 * email that version had already read.
 */
class IngestedByPreviousPoller extends Error {
  constructor(readonly invoiceIds: string[]) {
    super('Ingested by the previous poller meanwhile');
  }
}

/** A Prisma unique-constraint violation. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

export class GmailService {
  /**
   * Outbound mail: the driver welcome email. Always the shared GMAIL_*
   * credentials, whatever mailbox the poller reads.
   */
  private static outboundAuth = new google.auth.OAuth2(
    env.gmailClientId,
    env.gmailClientSecret,
    OAUTH_REDIRECT_URI
  );

  /** The invoice inbox: GMAIL_INBOX_*, falling back to GMAIL_*. */
  private static inboxAuth = new google.auth.OAuth2(
    env.gmailInbox.clientId,
    env.gmailInbox.clientSecret,
    OAUTH_REDIRECT_URI
  );

  static {
    if (env.gmailRefreshToken) {
      this.outboundAuth.setCredentials({ refresh_token: env.gmailRefreshToken });
    }
    if (env.gmailInbox.refreshToken) {
      this.inboxAuth.setCredentials({ refresh_token: env.gmailInbox.refreshToken });
    }
  }

  private static gmail = google.gmail({ version: 'v1', auth: this.outboundAuth });
  private static inbox = google.gmail({ version: 'v1', auth: this.inboxAuth });

  /** Replaced by the tests, so no OCR runs. */
  static triggerOcr: (jobId: string) => void = triggerOcrProcessing;

  /** Replaced by the tests, so no model is called. */
  static triage: Triage = triageDocument;

  /** The clock, for the poll lease. Replaced by the tests. */
  static now: () => Date = () => new Date();

  private static isPolling = false;
  /** Label name → id, resolved once per process. */
  private static labelIds = new Map<string, string>();
  /** The token's mailbox, read once per process. */
  private static profileAddress: string | null = null;
  private static lastSuccessAt: string | null = null;
  /** Log lines already written, so a 60s poll does not repeat itself. */
  private static warned = new Set<string>();

  /** Clears the per-process caches. For tests. */
  static resetState() {
    this.isPolling = false;
    this.labelIds.clear();
    this.profileAddress = null;
    this.lastSuccessAt = null;
    this.warned.clear();
  }

  private static warnOnce(key: string, message: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(message);
  }

  /**
   * Polls the invoice inbox for supplier invoices.
   *
   * Scope is deliberately narrow. The original query was `is:unread
   * has:attachment` with no sender check, which made every unread message
   * carrying a PDF or image into an `Invoice` row. Polling requires a label,
   * and only a sender the supplier records (or the env allowlist) know has
   * invoices created. Everything else waits in the review queue: an
   * `EmailIngestionEvent` marked NEEDS_REVIEW, and the review label on the
   * message so it is not fetched again every minute.
   *
   * A message is done when it carries the processed label, not when it is
   * read: a person opening it in Gmail must not hide it from the poller. It
   * is still marked read, so the inbox shows what the app has handled.
   */
  static async pollInvoices(config: GmailInboxConfig = env.gmailInbox) {
    if (this.isPolling) {
      console.log('⏳ Gmail polling already in progress. Skipping...');
      return;
    }

    const counts = emptyCounts();
    const status: GmailPollStatus = {
      mode: config.ingestMode,
      enabled: false,
      disabledReason: null,
      invoiceLabel: config.invoiceLabel || null,
      invoiceLabelFound: null,
      processedLabel: config.processedLabel,
      observedLabel: config.observedLabel,
      reviewLabel: config.reviewLabel,
      pollAfter: config.pollAfter,
      unreadOnly: !config.pollAfter,
      trustedForwarders: config.trustedForwarders.length,
      allowlistEntries: config.senderAllowlist.length,
      mailbox: maskAddress(this.profileAddress),
      mailboxMatchesConfig: null,
      lastPollAt: new Date().toISOString(),
      lastResult: 'disabled',
      lastError: null,
      lastSuccessAt: this.lastSuccessAt,
      counts,
      truncated: false,
    };

    const disabled = gmailPollDisabledReason(config);
    if (disabled) {
      this.warnOnce(`disabled:${disabled}`, `⚠️ Gmail invoice polling is disabled: ${disabled}`);
      status.disabledReason = disabled;
      await writeGmailStatus(status);
      return;
    }

    this.isPolling = true;
    let leased = false;
    let leaseLost = false;
    let renewal: ReturnType<typeof setInterval> | null = null;
    try {
      // Another process (the API and the worker both poll) has the inbox this
      // minute. It reports the poll; this one says nothing.
      leased = await acquirePollLease(LEASE_HOLDER, this.now());
      if (!leased) {
        this.warnOnce('lease-held', 'Gmail polling is being done by another process; this one waits its turn.');
        this.isPolling = false;
        return;
      }
      renewal = setInterval(() => {
        renewPollLease(LEASE_HOLDER, this.now())
          .then((held) => { if (!held) leaseLost = true; })
          .catch((error) => console.error('[Gmail] Could not renew the poll lease:', error));
      }, POLL_LEASE_RENEW_MS);
      renewal.unref?.();
    } catch (error) {
      // No database: nothing below could be recorded anyway.
      console.error('❌ Error polling Gmail:', error);
      this.isPolling = false;
      status.lastResult = 'error';
      status.lastError = describeError(error);
      await writeGmailStatus(status);
      return;
    }
    // Stops the poll between messages once another process has taken the
    // lease (this one stalled past it): the two must not work side by side.
    const stillHeld = () => {
      if (leaseLost) throw new Error('Another process took over the inbox poll; this one stopped.');
    };

    status.enabled = true;
    try {
      const mailbox = await this.mailboxAddress();
      status.mailbox = maskAddress(mailbox);
      if (config.user) {
        status.mailboxMatchesConfig = mailbox === config.user;
        if (!status.mailboxMatchesConfig) {
          if (config.userExplicit) {
            // The token is for some other mailbox. Reading it would ingest that
            // mailbox's attachments, so stop rather than guess.
            status.enabled = false;
            status.disabledReason =
              'The inbox token belongs to a different mailbox than GMAIL_INBOX_USER. Issue a token for that mailbox.';
            this.warnOnce('mailbox-mismatch', `⚠️ Gmail invoice polling is disabled: ${status.disabledReason}`);
            return;
          }
          this.warnOnce(
            'mailbox-differs',
            '⚠️ The Gmail inbox token is not for GMAIL_USER. Polling continues; set GMAIL_INBOX_USER to make this a hard check.'
          );
        }
      }

      const labels = await this.labelsByName();
      status.invoiceLabelFound = labels.has(config.invoiceLabel.toLowerCase());
      if (!status.invoiceLabelFound) {
        this.warnOnce(
          `no-label:${config.invoiceLabel}`,
          `⚠️ The Gmail label "${config.invoiceLabel}" does not exist in the polled mailbox, so nothing will be found.`
        );
      }
      // The processed label exists in both modes: the query excludes it, and
      // a search term for a label the mailbox does not have is not something
      // to rely on.
      const processedLabelId = await this.ensureLabel(config.processedLabel);
      const pollLabels: PollLabels = {
        done: config.ingestMode === 'observe' ? await this.ensureLabel(config.observedLabel) : processedLabelId,
        review: await this.ensureLabel(config.reviewLabel),
      };

      // Mail whose sender was approved since the last poll comes first. It
      // carries the review label, so the query below no longer finds it.
      // Observe mode creates nothing, so it leaves these for ingest mode.
      const handled = new Set<string>();
      if (config.ingestMode === 'ingest') {
        const requeued = await prisma.emailIngestionEvent.findMany({
          // An email whose last try failed has its requeuedAt moved to its
          // retry time, so it neither runs early nor holds a place in this
          // batch that a later approval needs.
          where: { status: EmailIngestionStatus.NEEDS_REVIEW, requeuedAt: { lte: this.now() } },
          orderBy: { requeuedAt: 'asc' },
          take: PAGE_SIZE,
          select: { gmailMessageId: true },
        });
        // The approval was saved by the API, usually another process, whose
        // cache clear does not reach this one. Read the supplier records
        // afresh, or a list cached before the approval would send the email
        // straight back to the queue with its re-queue used up.
        if (requeued.length > 0) invalidateKnownSenders();
        for (const { gmailMessageId } of requeued) {
          stillHeld();
          handled.add(gmailMessageId);
          const outcome = await this.processMessage(gmailMessageId, config, pollLabels, counts, true);
          counts[outcome] += 1;
          counts.requeued += 1;
        }
      }

      const query = buildInboxQuery(config);
      const ids = await this.listMessageIds(query, status);
      counts.listed = ids.length;
      if (ids.length > 0) console.log(`📬 ${ids.length} message(s) to check in Gmail label "${config.invoiceLabel}".`);

      for (const id of ids) {
        if (handled.has(id)) continue;
        stillHeld();
        const outcome = await this.processMessage(id, config, pollLabels, counts, false);
        counts[outcome] += 1;
      }

      status.lastResult = 'ok';
      this.lastSuccessAt = status.lastPollAt;
      status.lastSuccessAt = this.lastSuccessAt;
    } catch (error) {
      console.error('❌ Error polling Gmail:', error);
      status.lastResult = 'error';
      status.lastError = describeError(error);
    } finally {
      if (!status.enabled) status.lastResult = 'disabled';
      if (renewal) clearInterval(renewal);
      if (leased && !leaseLost) {
        await releasePollLease(LEASE_HOLDER).catch((error) => console.error('[Gmail] Could not release the poll lease:', error));
      }
      this.isPolling = false;
      await writeGmailStatus(status);
    }
  }

  /** The address the inbox token belongs to. */
  private static async mailboxAddress(): Promise<string> {
    if (this.profileAddress) return this.profileAddress;
    const res = await this.inbox.users.getProfile({ userId: 'me' });
    const address = (res.data.emailAddress ?? '').toLowerCase();
    if (!address) throw new Error('Gmail did not report the mailbox address');
    this.profileAddress = address;
    return address;
  }

  private static async labelsByName(): Promise<Map<string, string>> {
    const res = await this.inbox.users.labels.list({ userId: 'me' });
    const byName = new Map<string, string>();
    for (const label of res.data.labels ?? []) {
      if (label.name && label.id) byName.set(label.name.toLowerCase(), label.id);
    }
    return byName;
  }

  /** The id of a label, creating the label when the mailbox does not have it. */
  private static async ensureLabel(name: string): Promise<string> {
    const cached = this.labelIds.get(name.toLowerCase());
    if (cached) return cached;

    let id = (await this.labelsByName()).get(name.toLowerCase());
    if (!id) {
      try {
        const created = await this.inbox.users.labels.create({
          userId: 'me',
          requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
        });
        id = created.data.id ?? undefined;
        console.log(`🏷️ Created Gmail label "${name}".`);
      } catch (error) {
        // Another process (the API and the worker during a rollout) may have
        // created it a moment ago.
        id = (await this.labelsByName()).get(name.toLowerCase());
        if (!id) throw error;
      }
    }
    if (!id) throw new Error(`Gmail label "${name}" could not be created`);
    this.labelIds.set(name.toLowerCase(), id);
    return id;
  }

  /** Message ids matching the query, newest first, at most MAX_PAGES pages. */
  private static async listMessageIds(query: string, status: GmailPollStatus): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const res = await this.inbox.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const message of res.data.messages ?? []) {
        if (message.id) ids.push(message.id);
      }
      pageToken = res.data.nextPageToken ?? undefined;
      pages += 1;
    } while (pageToken && pages < MAX_PAGES);
    status.truncated = Boolean(pageToken);
    return [...new Set(ids)];
  }

  /**
   * Handles one message and says what happened to it. Never throws.
   *
   * `requeued` is mail whose sender was approved: it is fetched by id rather
   * than found by the query, because it carries the review label.
   */
  private static async processMessage(
    messageId: string,
    config: GmailInboxConfig,
    labels: PollLabels,
    counts: GmailPollCounts,
    requeued: boolean
  ): Promise<Outcome> {
    let facts: MessageFacts | null = null;
    const outcome: ReadOutcome = { records: [], createdInvoiceIds: [], createdTicketIds: [] };
    try {
      const existing = await prisma.emailIngestionEvent.findUnique({
        where: { gmailMessageId: messageId },
        select: { status: true, createdInvoiceIds: true, createdTicketIds: true, requeuedAt: true, errorMessage: true },
      });
      // Failed a moment ago: left until its retry time, before anything is
      // fetched or paid for.
      if (config.ingestMode === 'ingest' && this.waitingToRetry(existing)) return 'deferred';

      const res = await this.inbox.users.messages.get({ userId: 'me', id: messageId });
      const payload = res.data.payload ?? undefined;
      const headers = payload?.headers ?? [];
      const sender = resolveSender(headers, messageBody(payload), { trustedForwarders: config.trustedForwarders });
      const internal = Number(res.data.internalDate);
      facts = {
        messageId,
        payload,
        subject: headerValues(headers, 'Subject')[0] ?? 'No Subject',
        rawFrom: headerValues(headers, 'From')[0] ?? 'Unknown',
        toAddress: (headerValues(headers, 'To')[0] ?? '').slice(0, 1000),
        receivedAt: Number.isFinite(internal) && internal > 0 ? new Date(internal) : new Date(),
        sender,
        lookup: sender.mode === 'unknown'
          ? NOBODY
          : lookupSender(await knownSenders(), sender.originalSender, config.senderAllowlist),
        existing,
      };

      if (config.ingestMode === 'observe') {
        return await this.observeMessage(facts, labels);
      }

      // Somebody decided this email is not one to read. If it comes back to
      // the query (its review label removed by hand), it is put back.
      if (facts.existing?.status === EmailIngestionStatus.IGNORED) {
        await this.markReview(messageId, labels);
        return 'needsReview';
      }

      // Older than the go-live date. The query never lists such mail, but an
      // email queued during the census and approved since is fetched by id:
      // AP entered it by hand, so reading it now would bill it twice.
      const cutoff = readCutoff(config);
      if (cutoff && facts.receivedAt < cutoff) {
        console.log(`Email ${messageId} arrived before GMAIL_POLL_AFTER; left for a person.`);
        await this.queueForReview(facts, labels, 'BEFORE_CUTOFF',
          heldRecords(triageAttachments(payload), ATTACHMENT_REASONS.beforeCutoff));
        return 'needsReview';
      }

      // A message from the forwarder whose real sender cannot be established is
      // not a supplier's, however it is labelled. It waits for a person.
      if (sender.mode === 'unknown') {
        console.warn(`Labelled message ${messageId} sent to review: ${sender.reason} "${facts.subject}"`);
        await this.queueForReview(facts, labels, 'UNRESOLVED_SENDER',
          heldRecords(triageAttachments(payload), ATTACHMENT_REASONS.held));
        return 'unresolvedSender';
      }

      // The label scopes the query, but a mislabelled message must not become
      // an invoice on the strength of the label alone. A sender no supplier
      // record knows waits for the office to approve or ignore it; nothing is
      // downloaded meanwhile.
      if (!facts.lookup.known) {
        console.warn(`Labelled message from unrecognised sender ${sender.originalSender} sent to review: "${facts.subject}"`);
        await this.queueForReview(facts, labels, 'UNKNOWN_SENDER',
          heldRecords(triageAttachments(payload), ATTACHMENT_REASONS.held));
        return 'rejectedSender';
      }

      const via = sender.forwardedBy ? ` (${sender.mode} via ${sender.forwardedBy})` : '';
      console.log(`Processing email from ${sender.originalSender}${via}: "${facts.subject}"`);

      // The previous poller keyed invoices by attachmentId and only marked a
      // message read once every attachment was in. A row under that key means
      // this message was handled before the upgrade: ingesting it again under
      // the new key would bill it twice.
      const invoiceByKey = new Map<string, string>();
      let read: ReadOutcome;
      try {
        await this.refreshInvoiceKeys(messageId, invoiceByKey);
        read = await this.readAttachments(facts, invoiceByKey, counts, outcome);
      } catch (error) {
        if (!(error instanceof IngestedByPreviousPoller)) throw error;
        console.log(`Email ${messageId} was ingested by the previous poller. Skipping.`);
        await this.recordEvent(facts, {
          ...this.eventBase(facts),
          status: EmailIngestionStatus.PROCESSED,
          reviewReason: null,
          attachments: [],
          createdInvoiceIds: error.invoiceIds,
          note: 'Read by the poller before the upgrade; not read again.',
        });
        await this.markDone(messageId, labels, true);
        return 'legacySkipped';
      }
      const { records, createdInvoiceIds, createdTicketIds } = read;

      const review = attachmentReviewReason(records);
      if (review) {
        // Nothing here was dropped: what was read is read, and the rest is on
        // the event with its reason, waiting for a person.
        await this.queueForReview(facts, labels, review, records, createdInvoiceIds, createdTicketIds);
        return review === 'NO_INVOICE_ATTACHMENT' ? 'noAttachments' : 'needsReview';
      }

      await this.recordEvent(facts, {
        ...this.eventBase(facts),
        status: EmailIngestionStatus.PROCESSED,
        reviewReason: null,
        attachments: records,
        createdInvoiceIds,
        createdTicketIds,
        note: null,
      });
      await this.markDone(messageId, labels, true);
      console.log(`Successfully processed email ${messageId}`);
      return 'processed';
    } catch (error) {
      if (requeued && isNotFound(error)) {
        // Approved, but the email has since been deleted from Gmail. Say so
        // instead of trying again every minute.
        await prisma.emailIngestionEvent.update({
          where: { gmailMessageId: messageId },
          data: {
            status: EmailIngestionStatus.FAILED,
            requeuedAt: null,
            errorMessage: 'The email is no longer in the Gmail inbox, so it could not be read.',
          },
        }).catch(() => undefined);
      }
      console.error(`Error processing message ${messageId}:`, error);
      if (facts && config.ingestMode === 'ingest' && !(requeued && isNotFound(error))) {
        try {
          return await this.recordFailure(facts, labels, error, requeued, outcome);
        } catch (recordError) {
          console.error(`Could not record the failure of message ${messageId}:`, recordError);
        }
      }
      return 'failed';
    }
  }

  /** True while an email that failed is waiting for its next try. */
  private static waitingToRetry(existing: ExistingEvent): boolean {
    if (!existing) return false;
    // Only an email still being retried: one a person put back (its review
    // label removed by hand) is tried at once.
    const retrying = existing.status === EmailIngestionStatus.FAILED
      || (existing.status === EmailIngestionStatus.NEEDS_REVIEW && existing.requeuedAt !== null);
    const failure = readFailure(existing.errorMessage);
    if (!retrying || !failure) return false;
    return this.now().getTime() < failure.at.getTime() + retryDelayMs(failure.attempts);
  }

  /**
   * Counts a failed try on the email's event. Below MAX_READ_ATTEMPTS the
   * email is tried again after retryDelayMs: one from the query stays in it
   * (FAILED), an approved one keeps its place in the re-queue with
   * `requeuedAt` moved to its retry time. At the limit it goes to the review
   * queue (READ_FAILED, the review label) with the error, and whatever an
   * earlier attachment made stays listed.
   */
  private static async recordFailure(
    facts: MessageFacts,
    labels: PollLabels,
    error: unknown,
    requeued: boolean,
    outcome: ReadOutcome
  ): Promise<Outcome> {
    const now = this.now();
    const attempts = (readFailure(facts.existing?.errorMessage)?.attempts ?? 0) + 1;
    const message = describeError(error);
    const errorMessage = failureNote(attempts, now, message);
    const records = outcome.records.length > 0
      ? outcome.records
      : triageAttachments(facts.payload).map((candidate) => candidate.record);
    const base = {
      ...this.eventBase(facts),
      createdInvoiceIds: outcome.createdInvoiceIds,
      createdTicketIds: outcome.createdTicketIds,
      note: null,
      errorMessage,
    };

    if (attempts >= MAX_READ_ATTEMPTS) {
      // A file that was going to be read and never was: a person reads it.
      const unread = (r: AttachmentRecord) => r.action === 'read' && !r.invoiceId && !r.ticketIds?.length
        && !r.supportingInvoiceId && !r.pages;
      await this.recordEvent(facts, {
        ...base,
        status: EmailIngestionStatus.NEEDS_REVIEW,
        reviewReason: 'READ_FAILED',
        attachments: records.map((r) => (unread(r)
          ? { ...r, action: 'review' as const, reason: `${ATTACHMENT_REASONS.readFailed}: ${message}`.slice(0, 300) }
          : r)),
      });
      await this.markReview(facts.messageId, labels);
      console.warn(`Email ${facts.messageId} failed ${attempts} times; it waits in the review queue.`);
      return 'needsReview';
    }

    await this.recordEvent(facts, {
      ...base,
      status: requeued ? EmailIngestionStatus.NEEDS_REVIEW : EmailIngestionStatus.FAILED,
      // An approved email keeps the reason it was queued for.
      reviewReason: requeued ? 'UNKNOWN_SENDER' : null,
      attachments: records,
      requeuedAt: requeued ? new Date(now.getTime() + retryDelayMs(attempts)) : null,
    });
    return 'failed';
  }

  /**
   * Loads the invoices already made from this message into `invoiceByKey`.
   * Throws IngestedByPreviousPoller when any carries the previous poller's
   * key. Called before reading, and again just before an invoice is created,
   * because sorting pages takes seconds and the other version may have filed
   * the email meanwhile, under a key the unique index cannot compare.
   */
  private static async refreshInvoiceKeys(messageId: string, invoiceByKey: Map<string, string>) {
    const rows = await prisma.invoice.findMany({
      where: { gmailMessageId: { startsWith: `${messageId}:` } },
      select: { id: true, gmailMessageId: true },
    });
    const legacy = rows.filter(row => !isCurrentKeySuffix(row.gmailMessageId!.slice(messageId.length + 1)));
    if (legacy.length > 0) throw new IngestedByPreviousPoller(rows.map(row => row.id));
    for (const row of rows) invoiceByKey.set(row.gmailMessageId!, row.id);
  }

  /**
   * Reads every attachment of an email from a known sender and says what
   * happened to each.
   *
   * PDFs and images first: each is sorted page by page (invoice, delivery
   * ticket, statement, credit memo, other) before anything is created, so a
   * ticket attached to the invoice email becomes a ticket and a statement
   * becomes nothing. Spreadsheets last, because what they are depends on the
   * rest of the email: beside a PDF invoice an Excel file is that invoice's
   * load breakdown and is kept with it; on its own it is read as the invoice.
   *
   * Every created row carries a key derived from the message, so a poll that
   * fails half way and runs again finds what it already made.
   */
  private static async readAttachments(
    facts: MessageFacts,
    invoiceByKey: Map<string, string>,
    counts: GmailPollCounts,
    outcome: ReadOutcome
  ): Promise<ReadOutcome> {
    const { messageId } = facts;
    const [tickets, supporting] = await Promise.all([
      prisma.ticket.findMany({
        where: { emailSourceKey: { startsWith: `${messageId}:` } },
        select: { id: true, emailSourceKey: true },
      }),
      prisma.invoiceSupportingFile.findMany({
        where: { gmailKey: { startsWith: `${messageId}:` } },
        select: { gmailKey: true, invoiceId: true },
      }),
    ]);
    const ticketByKey = new Map(tickets.map((row) => [row.emailSourceKey!, row.id]));
    const supportingByKey = new Map(supporting.map((row) => [row.gmailKey!, row.invoiceId]));

    const candidates = triageAttachments(facts.payload);
    const records: AttachmentRecord[] = candidates.map((candidate) => candidate.record);
    // Filled in place, so a failure part way still knows what was made.
    outcome.records = records;
    const sheets: Array<{ index: number; key: string; record: AttachmentRecord; buffer: Buffer }> = [];

    for (const [index, candidate] of candidates.entries()) {
      if (!candidate.needsBytes) continue;
      const { part } = candidate;

      let key = attachmentKey(messageId, part);
      const known = key ? invoiceByKey.get(key) : undefined;
      if (key && known) {
        counts.duplicates += 1;
        outcome.createdInvoiceIds.push(known);
        records[index] = { ...candidate.record, action: 'read', reason: ATTACHMENT_REASONS.duplicate, invoiceId: known };
        continue;
      }
      const keptWith = key ? supportingByKey.get(key) : undefined;
      if (key && keptWith) {
        counts.duplicates += 1;
        records[index] = { ...candidate.record, action: 'read', reason: ATTACHMENT_REASONS.supportingFile, supportingInvoiceId: keptWith };
        continue;
      }

      const attachRes = await this.inbox.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: part.body!.attachmentId!,
      });
      const buffer = Buffer.from(attachRes.data.data ?? '', 'base64url');
      const record = classifyDownloaded(candidate.record, buffer);
      records[index] = record;
      if (record.action !== 'read') continue;

      key ??= attachmentKey(messageId, part, buffer)!;
      const hashed = invoiceByKey.get(key);
      if (hashed) {
        counts.duplicates += 1;
        outcome.createdInvoiceIds.push(hashed);
        records[index] = { ...record, reason: ATTACHMENT_REASONS.duplicate, invoiceId: hashed };
        continue;
      }

      if (record.kind === 'spreadsheet') {
        sheets.push({ index, key, record, buffer });
        continue;
      }
      records[index] = await this.fileDocument(facts, key, record, buffer, invoiceByKey, ticketByKey, counts, outcome);
    }

    // The invoice the email's PDF became, on this poll or an earlier one.
    const sheetKeys = new Set(sheets.map((sheet) => sheet.key));
    for (const sheet of sheets) {
      let invoiceId = outcome.createdInvoiceIds[0];
      if (!invoiceId) {
        // Read the sheet as the invoice only when nothing else in the email
        // became one, looked up afresh: a poller that lost the race on the
        // PDF knows its invoice only from the database.
        await this.refreshInvoiceKeys(messageId, invoiceByKey);
        invoiceId = [...invoiceByKey.entries()].find(([key]) => !sheetKeys.has(key))?.[1];
      }
      if (invoiceId) {
        const name = storedFileName(sheet.record.name, sheet.buffer, 'spreadsheet');
        console.log(`Keeping ${name} with invoice ${invoiceId} as a supporting file`);
        await InvoiceService.attachSupportingFile({ invoiceId, buffer: sheet.buffer, originalName: name, gmailKey: sheet.key });
        counts.supportingFiles += 1;
        records[sheet.index] = {
          ...sheet.record,
          action: 'read',
          reason: ATTACHMENT_REASONS.supportingFile,
          supportingInvoiceId: invoiceId,
        };
        continue;
      }
      records[sheet.index] = await this.fileDocument(
        facts, sheet.key, sheet.record, sheet.buffer, invoiceByKey, ticketByKey, counts, outcome
      );
    }

    return outcome;
  }

  /**
   * Sorts one downloaded attachment's pages and creates what they are: one
   * invoice from the invoice pages, one emailed ticket per ticket page, and
   * nothing for statements, credit memos and other pages, which are recorded
   * with the reason. Tickets are filed before the invoice, so an invoice
   * already on file for this key means its tickets are too.
   */
  private static async fileDocument(
    facts: MessageFacts,
    key: string,
    record: AttachmentRecord,
    buffer: Buffer,
    invoiceByKey: Map<string, string>,
    ticketByKey: Map<string, string>,
    counts: GmailPollCounts,
    outcome: ReadOutcome
  ): Promise<AttachmentRecord> {
    const mimeType = readableMimeType(record, buffer);
    const pdf = record.kind === 'pdf' ? await inspectPdf(buffer) : { pageCount: null, encrypted: false };
    const pageCount = pdf.pageCount;
    const splittable = pageCount !== null && pageCount > 1 && pageCount <= MAX_SPLIT_PAGES && !pdf.encrypted;

    let plan: PagePlan;
    let note: string | null = null;
    /** Pages the sorter called tickets in a file of several pages that cannot be split. */
    let ticketsTrapped = false;
    try {
      const triage = await this.triage(buffer, mimeType, record.name || 'attachment');
      plan = planPages(triage, splittable ? pageCount : null);
      // Handled whole, a file of several tickets would become one ticket from
      // its first page (only page 1 is rendered for OCR), and the rest would
      // be lost. Its pages are counted when pdf-lib can read the page tree,
      // else taken from the sorter's answer.
      const pages = pageCount ?? new Set((triage.pages ?? []).map((p) => Math.trunc(p.page))).size;
      ticketsTrapped = !plan.split && record.kind === 'pdf' && pages > 1
        && (triage.pages ?? []).some((p) => p.kind === 'delivery_ticket');
    } catch (error) {
      // A rate limit or an outage: the email is tried again on the next poll,
      // before anything is created from it.
      if (!(error instanceof ExtractionError) || error.retryable) throw error;
      if (record.kind === 'spreadsheet') {
        // The same bytes will not read better next minute; a person enters it.
        return { ...record, action: 'review', reason: `${ATTACHMENT_REASONS.unreadableSheet}: ${error.message}`.slice(0, 300) };
      }
      // The sorting call refused this file for good. Read it as an invoice,
      // which is what the inbox always did; the reader skips ticket pages.
      console.warn(`Could not sort the pages of ${record.name || key}: ${error.message}`);
      plan = unsortedPlan();
      note = ATTACHMENT_REASONS.sortFailed;
    }

    const ticketIds: string[] = [];
    // A spreadsheet is never filed as a ticket: tickets are photos and scans.
    // Nor is a file of several tickets that could not be split: a person
    // files those (below), rather than the app filing page 1 as all of them.
    const ticketPages = record.kind === 'spreadsheet' || ticketsTrapped ? [] : plan.ticketPages;
    for (const page of ticketPages) {
      const ticketKey = `${key}#${page}`;
      const existing = ticketByKey.get(ticketKey);
      if (existing) {
        ticketIds.push(existing);
        continue;
      }
      const bytes = plan.split ? await extractPdfPages(buffer, [page]) : buffer;
      const name = plan.split ? pageFileName(record.name, page) : storedFileName(record.name, buffer);
      try {
        const { ticket } = await TicketService.ingestEmailTicket({
          buffer: bytes,
          originalName: name,
          // The supplier, never the AP mailbox that forwarded it.
          fromEmail: facts.sender.originalSender!,
          // Unknown here (an allow-listed address with no supplier record): the
          // ticket service looks the sender up itself.
          supplierId: facts.lookup.supplier?.id,
          emailSourceKey: ticketKey,
        });
        ticketByKey.set(ticketKey, ticket.id);
        ticketIds.push(ticket.id);
        counts.ticketsCreated += 1;
      } catch (error) {
        // The other poller filed it a moment ago.
        if (!isUniqueViolation(error)) throw error;
        counts.duplicates += 1;
      }
    }
    outcome.createdTicketIds.push(...ticketIds);

    let invoiceId: string | null = null;
    if (plan.invoicePages.length > 0) {
      await this.refreshInvoiceKeys(facts.messageId, invoiceByKey);
      const filed = invoiceByKey.get(key);
      if (filed) {
        // Another poller made it while this one was sorting the pages.
        counts.duplicates += 1;
        outcome.createdInvoiceIds.push(filed);
        return { ...record, pages: plan.pages, ticketIds, invoiceId: filed, reason: ATTACHMENT_REASONS.duplicate };
      }
      const whole = !plan.split || plan.invoicePages.length === plan.pages.length;
      const bytes = whole ? buffer : await extractPdfPages(buffer, plan.invoicePages);
      console.log(`Ingesting attachment: ${record.name || '(no name)'}${whole ? '' : ` (pages ${plan.invoicePages.join(', ')})`}`);
      try {
        const result = await InvoiceService.ingestEmailInvoice({
          buffer: bytes,
          originalName: storedFileName(record.name, bytes, record.kind),
          // The supplier, not the AP mailbox that forwarded it: supplier
          // attribution and Invoice.emailFrom both read this.
          fromEmail: facts.sender.originalSender!,
          subject: facts.subject,
          gmailMessageId: key,
        });
        invoiceId = result.invoice.id;
        invoiceByKey.set(key, invoiceId);
        outcome.createdInvoiceIds.push(invoiceId);
        counts.invoicesCreated += 1;
        if (result.ocrJob.id) this.triggerOcr(result.ocrJob.id);
      } catch (error) {
        // Another poller won the race on the unique key. Its invoice is this
        // email's invoice: the Excel beside it is kept with it, and the
        // email's record names it.
        if (!isUniqueViolation(error)) throw error;
        counts.duplicates += 1;
        const winner = await prisma.invoice.findUnique({ where: { gmailMessageId: key }, select: { id: true } });
        if (winner) {
          invoiceByKey.set(key, winner.id);
          outcome.createdInvoiceIds.push(winner.id);
        }
        return {
          ...record,
          pages: plan.pages,
          ticketIds,
          reason: ATTACHMENT_REASONS.duplicate,
          ...(winner ? { invoiceId: winner.id } : {}),
        };
      }
    }

    if (ticketsTrapped) {
      // The invoice, if any, was read whole (its reader skips ticket pages);
      // the tickets wait for a person either way.
      return {
        ...record,
        action: invoiceId ? 'read' : 'review',
        reason: ATTACHMENT_REASONS.ticketsNotSplit,
        pages: plan.pages,
        ...(invoiceId ? { invoiceId } : {}),
      };
    }

    const created = invoiceId !== null || ticketIds.length > 0;
    const single = plan.pages.length === 1 ? plan.pages[0]!.kind : null;
    // A spreadsheet of loads with no invoice beside it was not filed anywhere:
    // saying "filed with the tickets" would send a person looking for it there.
    const reason = note
      ?? (single === null
        ? describePages(plan.pages)
        : single === 'invoice'
          ? null
          : single === 'delivery_ticket' && record.kind === 'spreadsheet'
            ? ATTACHMENT_REASONS.sheetOfLoads
            : REASON_BY_KIND[single]);
    return {
      ...record,
      // A credit memo waits for a person; a statement or a cover letter is
      // only recorded.
      action: created ? 'read' : plan.pages.some((p) => p.kind === 'credit_memo') ? 'review' : 'skipped',
      reason,
      pages: plan.pages,
      ...(invoiceId ? { invoiceId } : {}),
      ...(ticketIds.length > 0 ? { ticketIds } : {}),
    };
  }

  /** The columns every event for this message shares. */
  private static eventBase(facts: MessageFacts) {
    const { sender, lookup } = facts;
    return {
      subject: facts.subject.slice(0, 500),
      fromAddress: sender.originalSender ?? parseAddress(facts.rawFrom) ?? facts.rawFrom.slice(0, 320),
      toAddress: facts.toAddress,
      originalFrom: sender.originalSender,
      forwardedBy: sender.forwardedBy,
      senderMode: sender.mode,
      supplierId: lookup.supplier?.id ?? null,
      senderTypeResolved: senderTypeResolved(lookup),
    };
  }

  /**
   * Writes the message's row in the mailbox log, creating or replacing it.
   * Invoices the email produced on an earlier poll stay listed. Writing it
   * clears a pending re-queue, so an approved email is read once.
   */
  private static async recordEvent(facts: MessageFacts, fields: EventFields) {
    const createdInvoiceIds = [...new Set([...(facts.existing?.createdInvoiceIds ?? []), ...fields.createdInvoiceIds])];
    const createdTicketIds = [...new Set([...(facts.existing?.createdTicketIds ?? []), ...(fields.createdTicketIds ?? [])])];
    const data = {
      ...fields,
      attachments: fields.attachments as unknown as Prisma.InputJsonValue,
      createdInvoiceIds,
      createdTicketIds,
      errorMessage: fields.errorMessage ?? null,
      requeuedAt: fields.requeuedAt ?? null,
    };
    const where = { gmailMessageId: facts.messageId };
    try {
      await prisma.emailIngestionEvent.upsert({
        where,
        create: { ...where, ...data, receivedAt: facts.receivedAt },
        update: data,
      });
    } catch (error) {
      // Both pollers created it at once; the row exists now, so update it.
      if (!isUniqueViolation(error)) throw error;
      await prisma.emailIngestionEvent.update({ where, data });
    }
  }

  /** Puts the message on the review queue: an event, and the review label. */
  private static async queueForReview(
    facts: MessageFacts,
    labels: PollLabels,
    reason: ReviewReason,
    attachments: AttachmentRecord[],
    createdInvoiceIds: string[] = [],
    createdTicketIds: string[] = []
  ) {
    await this.recordEvent(facts, {
      ...this.eventBase(facts),
      status: EmailIngestionStatus.NEEDS_REVIEW,
      reviewReason: reason,
      attachments,
      createdInvoiceIds,
      createdTicketIds,
      note: facts.sender.mode === 'unknown' ? facts.sender.reason : null,
    });
    await this.markReview(facts.messageId, labels);
  }

  /**
   * Observe mode: write down who sent the message and what it carried, and
   * create nothing. One `EmailIngestionEvent` per message, keyed by the bare
   * message id; the observed label keeps it out of the next poll. A sender
   * no supplier record knows is recorded as NEEDS_REVIEW, so the census shows
   * on the Invoices page and the office can map senders to suppliers there.
   */
  private static async observeMessage(facts: MessageFacts, labels: PollLabels): Promise<Outcome> {
    if (!facts.existing) {
      const triaged = triageAttachments(facts.payload);
      const attachments = heldRecords(triaged, ATTACHMENT_REASONS.observed);
      const known = facts.lookup.known;
      try {
        await prisma.emailIngestionEvent.create({
          data: {
            gmailMessageId: facts.messageId,
            ...this.eventBase(facts),
            status: known ? EmailIngestionStatus.PROCESSED : EmailIngestionStatus.NEEDS_REVIEW,
            reviewReason: known ? null : facts.sender.mode === 'unknown' ? 'UNRESOLVED_SENDER' : 'UNKNOWN_SENDER',
            attachments: attachments as unknown as Prisma.InputJsonValue,
            // Every file, inline logos included, so the census shows what
            // suppliers really send.
            note: censusNote(facts.sender, known, triaged.map(c => c.record)),
            receivedAt: facts.receivedAt,
          },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    // Observing is not ingesting: the message stays unread, and keeps no
    // processed label, so switching to ingest later still reads it.
    await this.inbox.users.messages.modify({
      userId: 'me',
      id: facts.messageId,
      requestBody: { addLabelIds: [labels.done] },
    });
    return 'observed';
  }

  /** Done: the processed label, read, and off the review queue. */
  private static async markDone(messageId: string, labels: PollLabels, markRead: boolean) {
    await this.inbox.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        addLabelIds: [labels.done],
        removeLabelIds: [labels.review, ...(markRead ? ['UNREAD'] : [])],
      },
    });
  }

  /** Waiting for a person: the review label, left unread so AP still sees it. */
  private static async markReview(messageId: string, labels: PollLabels) {
    await this.inbox.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { addLabelIds: [labels.review] },
    });
  }

  /**
   * Send an email using the shared (outbound) Gmail account.
   */
  static async sendEmail(to: string, subject: string, htmlBody: string) {
    if (!env.gmailClientId || !env.gmailRefreshToken) {
      console.warn('⚠️ Gmail API credentials not fully configured. Cannot send email.');
      return;
    }

    try {
      const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
      const messageParts = [
        `To: ${to}`,
        `Subject: ${utf8Subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=utf-8',
        '',
        htmlBody,
      ];
      const message = messageParts.join('\r\n');
      const encodedMessage = Buffer.from(message)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
        },
      });
      console.log(`Email sent successfully to ${to}`);
    } catch (error) {
      console.error(`❌ Error sending email to ${to}:`, error);
      throw error;
    }
  }
}
