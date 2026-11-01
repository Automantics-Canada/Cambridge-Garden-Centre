import { createHash } from 'node:crypto';
import { google, type gmail_v1 } from 'googleapis';
import { env } from '../config/env.js';
import {
  buildInboxQuery,
  gmailPollDisabledReason,
  type GmailInboxConfig,
} from '../config/gmailConfig.js';
import { InvoiceService } from '../modules/invoices/invoice.service.js';
import { prisma } from '../db/prisma.js';
import { triggerOcrProcessing } from './ocrJobProcessor.js';
import {
  headerValues,
  matchesSenderList,
  parseAddress,
  resolveSender,
  type ResolvedSender,
} from './emailSender.js';
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

/** File types the poller turns into invoices, by extension as before. */
const INVOICE_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png'];

type Part = gmail_v1.Schema$MessagePart;

/** Every part of a message, depth first. */
function allParts(payload: Part | undefined): Part[] {
  if (!payload) return [];
  return [payload, ...(payload.parts ?? []).flatMap(allParts)];
}

/** Parts that are attachments: a filename and a body stored by reference. */
function attachmentParts(payload: Part | undefined): Part[] {
  return allParts(payload).filter(part => part.filename && part.body?.attachmentId);
}

/** The PDF and image attachments, the only kinds read as invoices today. */
export function invoiceAttachments(payload: Part | undefined): Part[] {
  return attachmentParts(payload).filter(part => {
    const ext = part.filename!.split('.').pop()?.toLowerCase() ?? '';
    return INVOICE_EXTENSIONS.includes(ext);
  });
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
 * One line describing a message for the observe-mode census. Stored in
 * `EmailIngestionEvent.errorMessage`, the only free-text column the mailbox
 * log has until the review queue adds proper ones.
 */
export function censusNote(sender: ResolvedSender, allowlisted: boolean, attachments: Part[]): string {
  const files = attachments.length === 0
    ? 'none'
    : attachments.map(part => `${part.filename} (${part.mimeType ?? 'unknown type'})`).join(', ');
  return [
    'observe',
    `mode=${sender.mode}`,
    `forwardedBy=${sender.forwardedBy ?? '-'}`,
    `allowlisted=${allowlisted ? 'yes' : 'no'}`,
    `reason=${sender.reason}`,
    `attachments: ${files}`,
  ].join('; ').slice(0, 2000);
}

/** What happened to a message, as one of the per-message counters. */
type Outcome = Exclude<keyof GmailPollCounts, 'listed' | 'invoicesCreated' | 'duplicates'>;

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

  private static isPolling = false;
  /** Label name → id, resolved once per process. */
  private static labelIds = new Map<string, string>();
  /** The token's mailbox, read once per process. */
  private static profileAddress: string | null = null;
  private static lastSuccessAt: string | null = null;
  /**
   * Messages refused this process (sender not allowed, or not resolvable).
   * The allowlist only changes with a redeploy, which starts a new process,
   * so they are not fetched again until then.
   */
  private static refused = new Set<string>();
  /** Log lines already written, so a 60s poll does not repeat itself. */
  private static warned = new Set<string>();

  /** Clears the per-process caches. For tests. */
  static resetState() {
    this.isPolling = false;
    this.labelIds.clear();
    this.profileAddress = null;
    this.lastSuccessAt = null;
    this.refused.clear();
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
   * and in ingest mode a sender allowlist, and does nothing without them.
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
      const doneLabelId = config.ingestMode === 'observe'
        ? await this.ensureLabel(config.observedLabel)
        : processedLabelId;

      const query = buildInboxQuery(config);
      const ids = await this.listMessageIds(query, status);
      counts.listed = ids.length;
      if (ids.length > 0) console.log(`📬 ${ids.length} message(s) to check in Gmail label "${config.invoiceLabel}".`);

      for (const id of ids) {
        const outcome = await this.processMessage(id, config, doneLabelId, counts);
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

  /** Handles one message and says what happened to it. Never throws. */
  private static async processMessage(
    messageId: string,
    config: GmailInboxConfig,
    doneLabelId: string,
    counts: GmailPollCounts
  ): Promise<Outcome> {
    if (this.refused.has(messageId)) return 'rejectedSender';

    try {
      const res = await this.inbox.users.messages.get({ userId: 'me', id: messageId });
      const payload = res.data.payload ?? undefined;
      const headers = payload?.headers ?? [];
      const rawFrom = headerValues(headers, 'From')[0] ?? 'Unknown';
      const subject = headerValues(headers, 'Subject')[0] ?? 'No Subject';
      const sender = resolveSender(headers, messageBody(payload), { trustedForwarders: config.trustedForwarders });
      const allowlisted = sender.mode !== 'unknown' && matchesSenderList(sender.originalSender, config.senderAllowlist);

      if (config.ingestMode === 'observe') {
        return await this.observeMessage(messageId, payload, headers, rawFrom, subject, sender, allowlisted, doneLabelId);
      }

      // A message from the forwarder whose real sender cannot be established is
      // not a supplier's, however it is labelled. Left in place for a person.
      if (sender.mode === 'unknown') {
        this.refused.add(messageId);
        console.warn(`Skipping labelled message ${messageId}: ${sender.reason} "${subject}"`);
        return 'unresolvedSender';
      }

      // The label scopes the query, but a mislabelled message must not become an
      // invoice on the strength of the label alone. Left in place so a person
      // still sees it, and not fetched again until the next deploy.
      if (!allowlisted) {
        this.refused.add(messageId);
        console.warn(`Skipping labelled message from non-allowlisted sender ${sender.originalSender}: "${subject}"`);
        return 'rejectedSender';
      }

      const via = sender.forwardedBy ? ` (${sender.mode} via ${sender.forwardedBy})` : '';
      console.log(`Processing email from ${sender.originalSender}${via}: "${subject}"`);

      const attachments = invoiceAttachments(payload);
      if (attachments.length === 0) {
        console.log('No valid attachments found in this email.');
        await this.markDone(messageId, doneLabelId, true);
        return 'noAttachments';
      }

      const existing = await prisma.invoice.findMany({
        where: { gmailMessageId: { startsWith: `${messageId}:` } },
        select: { gmailMessageId: true },
      });
      const keys = new Set(existing.map(row => row.gmailMessageId));

      // The previous poller keyed invoices by attachmentId and only marked a
      // message read once every attachment was in. A row under that key means
      // this message was handled before the upgrade: ingesting it again under
      // the new key would bill it twice.
      const legacy = [...keys].some(key => !isCurrentKeySuffix(key.slice(messageId.length + 1)));
      if (legacy) {
        console.log(`Email ${messageId} was ingested before the upgrade. Skipping.`);
        await this.markDone(messageId, doneLabelId, true);
        return 'legacySkipped';
      }

      for (const part of attachments) {
        let key = attachmentKey(messageId, part);
        if (key && keys.has(key)) {
          counts.duplicates += 1;
          continue;
        }

        const attachRes = await this.inbox.users.messages.attachments.get({
          userId: 'me',
          messageId,
          id: part.body!.attachmentId!,
        });
        const buffer = Buffer.from(attachRes.data.data ?? '', 'base64url');
        key ??= attachmentKey(messageId, part, buffer)!;
        if (keys.has(key)) {
          counts.duplicates += 1;
          continue;
        }

        console.log(`Ingesting attachment: ${part.filename}`);
        try {
          const result = await InvoiceService.ingestEmailInvoice({
            buffer,
            originalName: part.filename || 'invoice.pdf',
            // The supplier, not the AP mailbox that forwarded it: supplier
            // attribution and Invoice.emailFrom both read this.
            fromEmail: sender.originalSender!,
            subject,
            gmailMessageId: key,
          });
          keys.add(key);
          counts.invoicesCreated += 1;
          if (result.ocrJob.id) this.triggerOcr(result.ocrJob.id);
        } catch (error) {
          // The API and the worker both poll during a rollout; whichever loses
          // the race on the unique key has nothing left to do.
          if (!isUniqueViolation(error)) throw error;
          keys.add(key);
          counts.duplicates += 1;
        }
      }

      await this.markDone(messageId, doneLabelId, true);
      console.log(`Successfully processed email ${messageId}`);
      return 'processed';
    } catch (error) {
      console.error(`Error processing message ${messageId}:`, error);
      return 'failed';
    }
  }

  /**
   * Observe mode: write down who sent the message and what it carried, and
   * create nothing. One `EmailIngestionEvent` per message, keyed by the bare
   * message id; the observed label keeps it out of the next poll.
   */
  private static async observeMessage(
    messageId: string,
    payload: Part | undefined,
    headers: gmail_v1.Schema$MessagePartHeader[],
    rawFrom: string,
    subject: string,
    sender: ResolvedSender,
    allowlisted: boolean,
    doneLabelId: string
  ): Promise<Outcome> {
    const existing = await prisma.emailIngestionEvent.findUnique({ where: { gmailMessageId: messageId } });
    if (!existing) {
      try {
        await prisma.emailIngestionEvent.create({
          data: {
            gmailMessageId: messageId,
            subject: subject.slice(0, 500),
            fromAddress: sender.originalSender ?? parseAddress(rawFrom) ?? rawFrom.slice(0, 320),
            toAddress: (headerValues(headers, 'To')[0] ?? '').slice(0, 1000),
            errorMessage: censusNote(sender, allowlisted, attachmentParts(payload)),
          },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    // Observing is not ingesting: the message stays unread, and keeps no
    // processed label, so switching to ingest later still reads it.
    await this.markDone(messageId, doneLabelId, false);
    return 'observed';
  }

  private static async markDone(messageId: string, labelId: string, markRead: boolean) {
    await this.inbox.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        addLabelIds: [labelId],
        ...(markRead ? { removeLabelIds: ['UNREAD'] } : {}),
      },
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
