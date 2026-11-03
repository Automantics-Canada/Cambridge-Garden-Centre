import { prisma } from '../db/prisma.js';
import type { GmailIngestMode } from '../config/gmailConfig.js';

/**
 * What the invoice inbox poller last did, for `GET /api/health`.
 *
 * The poller usually runs in the worker service, which has no HTTP surface,
 * so a mailbox that was never connected, a refresh token that expired or a
 * label nobody created only ever showed up as a log line on Railway. The
 * poller now writes one `SystemSetting` row after every poll and the health
 * endpoint reads it back, next to the worker heartbeat (workers/heartbeat.ts).
 *
 * The record holds configuration names, counts and timestamps only. No token,
 * secret or full email address is written: the health endpoint is public.
 */

/** How often the worker polls the inbox (workers/startWorkers.ts). */
export const GMAIL_POLL_INTERVAL_MS = 60 * 1000;

/** Three missed polls, as for the heartbeat: one is a slow poll, three is nobody polling. */
export const GMAIL_STATUS_STALE_AFTER_MS = 3 * GMAIL_POLL_INTERVAL_MS;

export const GMAIL_STATUS_KEY = 'gmail.status';

export interface GmailPollCounts {
  /** Messages the query returned this poll. */
  listed: number;
  /** Messages finished and labelled processed. */
  processed: number;
  /** Attachments that became invoices. */
  invoicesCreated: number;
  /** Delivery ticket pages filed as emailed tickets (A15). */
  ticketsCreated: number;
  /** Spreadsheets kept beside the PDF invoice of their email. */
  supportingFiles: number;
  /** Messages recorded in observe mode. */
  observed: number;
  /** Attachments skipped because an invoice already exists for them. */
  duplicates: number;
  /** Messages the previous poller had already ingested under its old key. */
  legacySkipped: number;
  /** Messages from a sender no supplier record knows; sent to review. */
  rejectedSender: number;
  /** Messages from a trusted forwarder whose original sender was not found; sent to review. */
  unresolvedSender: number;
  /** Messages with no attachment the app reads, not even an unsupported one; sent to review. */
  noAttachments: number;
  /** Messages from a known sender carrying an unreadable spreadsheet, a credit memo or only unsupported files; sent to review. */
  needsReview: number;
  /** Messages read again because their sender was approved. */
  requeued: number;
  /** Messages that failed and will be tried again. */
  failed: number;
}

export function emptyCounts(): GmailPollCounts {
  return {
    listed: 0, processed: 0, invoicesCreated: 0, ticketsCreated: 0, supportingFiles: 0, observed: 0, duplicates: 0,
    legacySkipped: 0, rejectedSender: 0, unresolvedSender: 0, noAttachments: 0, needsReview: 0,
    requeued: 0, failed: 0,
  };
}

export interface GmailPollStatus {
  mode: GmailIngestMode | null;
  enabled: boolean;
  disabledReason: string | null;
  invoiceLabel: string | null;
  /** Whether the invoice label exists in the mailbox; null when not checked. */
  invoiceLabelFound: boolean | null;
  processedLabel: string;
  observedLabel: string;
  reviewLabel: string;
  pollAfter: string | null;
  /** True while no GMAIL_POLL_AFTER is set and the query still needs is:unread. */
  unreadOnly: boolean;
  trustedForwarders: number;
  allowlistEntries: number;
  /** The polled mailbox, masked (`cg…@gmail.com`); null when not checked. */
  mailbox: string | null;
  /** Whether the token's mailbox is the configured inbox user; null when unknown. */
  mailboxMatchesConfig: boolean | null;
  lastPollAt: string;
  lastResult: 'ok' | 'error' | 'disabled';
  lastError: string | null;
  lastSuccessAt: string | null;
  counts: GmailPollCounts;
  /** More messages matched than one poll reads; the rest wait for the next. */
  truncated: boolean;
}

/**
 * What `GET /api/health` reports under `gmail`: the stored status with every
 * field nullable (nothing may have been written yet), plus whether anything
 * was and whether it is recent.
 */
export type GmailHealth = { [K in keyof GmailPollStatus]: GmailPollStatus[K] | null } & {
  /** False when no poller has ever written a status. */
  reported: boolean;
  /** No status, or the last poll is older than the stale window. */
  stale: boolean;
};

/** `cgcsoftware@gmail.com` → `cg…@gmail.com`. */
export function maskAddress(address: string | null | undefined): string | null {
  if (!address || !address.includes('@')) return null;
  const [local = '', domain = ''] = address.toLowerCase().split('@');
  return `${local.slice(0, 2)}…@${domain}`;
}

/**
 * An error as a short line that is safe to publish: email addresses masked,
 * anything that looks like a token or key removed, at most 200 characters.
 */
export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
  return raw
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, match => maskAddress(match) ?? '[address]')
    .replace(/[A-Za-z0-9_\-./+=]{24,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

const STRING_OR_NULL = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const BOOL_OR_NULL = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const NUM_OR_NULL = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Reads the stored status defensively: `SystemSetting.value` is Json, so a
 * hand-edited row could hold anything. Fields that do not have the expected
 * type come back null rather than being trusted.
 */
export function deriveGmailHealth(value: unknown, now: Date = new Date()): GmailHealth {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const lastPollAt = STRING_OR_NULL(record?.lastPollAt);
  const pollMs = lastPollAt ? Date.parse(lastPollAt) : Number.NaN;
  const stale = !Number.isFinite(pollMs) || now.getTime() - pollMs > GMAIL_STATUS_STALE_AFTER_MS;

  let counts: GmailPollCounts | null = null;
  if (record?.counts && typeof record.counts === 'object') {
    const source = record.counts as Record<string, unknown>;
    const filled = emptyCounts();
    for (const key of Object.keys(filled) as Array<keyof GmailPollCounts>) {
      filled[key] = NUM_OR_NULL(source[key]) ?? 0;
    }
    counts = filled;
  }

  const mode = record?.mode === 'ingest' || record?.mode === 'observe' ? record.mode : null;
  const lastResult = record?.lastResult === 'ok' || record?.lastResult === 'error' || record?.lastResult === 'disabled'
    ? record.lastResult
    : null;

  return {
    reported: record !== null,
    stale,
    mode,
    enabled: BOOL_OR_NULL(record?.enabled),
    disabledReason: STRING_OR_NULL(record?.disabledReason),
    invoiceLabel: STRING_OR_NULL(record?.invoiceLabel),
    invoiceLabelFound: BOOL_OR_NULL(record?.invoiceLabelFound),
    processedLabel: STRING_OR_NULL(record?.processedLabel),
    observedLabel: STRING_OR_NULL(record?.observedLabel),
    reviewLabel: STRING_OR_NULL(record?.reviewLabel),
    pollAfter: STRING_OR_NULL(record?.pollAfter),
    unreadOnly: BOOL_OR_NULL(record?.unreadOnly),
    trustedForwarders: NUM_OR_NULL(record?.trustedForwarders),
    allowlistEntries: NUM_OR_NULL(record?.allowlistEntries),
    mailbox: STRING_OR_NULL(record?.mailbox),
    mailboxMatchesConfig: BOOL_OR_NULL(record?.mailboxMatchesConfig),
    lastPollAt,
    lastResult,
    lastError: STRING_OR_NULL(record?.lastError),
    lastSuccessAt: STRING_OR_NULL(record?.lastSuccessAt),
    counts,
    truncated: BOOL_OR_NULL(record?.truncated),
  };
}

/** Records the poll's outcome. Never throws: reporting must not stop polling. */
export async function writeGmailStatus(status: GmailPollStatus): Promise<void> {
  try {
    const value = JSON.parse(JSON.stringify(status));
    await prisma.systemSetting.upsert({
      where: { key: GMAIL_STATUS_KEY },
      create: { key: GMAIL_STATUS_KEY, value, updatedAt: new Date() },
      update: { value, updatedAt: new Date() },
    });
  } catch (error) {
    console.error('[Gmail] Could not record the poll status:', error);
  }
}

/** The stored status value, or null when there is none. May throw; the caller decides. */
export async function readGmailStatus(): Promise<unknown> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: GMAIL_STATUS_KEY },
    select: { value: true },
  });
  return row?.value ?? null;
}
