/**
 * Configuration for the invoice inbox poller (services/gmail.service.ts).
 *
 * Supplier invoices are sent to ap@cambridgegardencentre.ca, a Microsoft 365
 * mailbox the app cannot read. Microsoft 365 forwards them to a Gmail account,
 * and the poller reads that Gmail account through the Gmail API. See
 * docs/gmail-mailbox-switch.md for the setup.
 *
 * Kept apart from env.ts, and pure, so the fallbacks and the fail-closed
 * parsing can be tested without loading the rest of the app's configuration.
 *
 * Inbox credentials. Each falls back to the shared GMAIL_* value, so a
 * deployment that sets only the old variables keeps polling the mailbox it
 * polls today. They are separate because the shared values also send driver
 * email (mail.service.ts, GmailService.sendEmail): switching the polled
 * mailbox must not change who sends a driver's welcome email.
 *
 *   GMAIL_INBOX_CLIENT_ID       falls back to GMAIL_CLIENT_ID
 *   GMAIL_INBOX_CLIENT_SECRET   falls back to GMAIL_CLIENT_SECRET
 *   GMAIL_INBOX_REFRESH_TOKEN   falls back to GMAIL_REFRESH_TOKEN
 *   GMAIL_INBOX_USER            falls back to GMAIL_USER. The address the token
 *                               should belong to. Set explicitly, a token for
 *                               any other mailbox stops the poller; from the
 *                               fallback it only warns, because GMAIL_USER is
 *                               the outbound sender and may legitimately differ.
 *
 * Scope:
 *
 *   GMAIL_INVOICE_LABEL         required. The Gmail label a filter puts on
 *                               mail forwarded from the AP mailbox.
 *   GMAIL_SENDER_ALLOWLIST      optional comma list of sender domains or
 *                               addresses, matched against the original
 *                               sender (see services/emailSender.ts). Senders
 *                               are known from the supplier records
 *                               (services/knownSenders.ts); this list only adds
 *                               to them. A free-mail domain here counts for
 *                               nothing; list the full address.
 *   GMAIL_TRUSTED_FORWARDERS    comma list of addresses that forward supplier
 *                               mail to this inbox, e.g. the AP mailbox. Only
 *                               full addresses: a domain would trust every
 *                               mailbox in it.
 *
 * Tracking and go-live:
 *
 *   GMAIL_PROCESSED_LABEL       added once a message is done (default
 *                               cgc-processed). The query excludes it, so a
 *                               person opening a message in Gmail no longer
 *                               hides it from the poller.
 *   GMAIL_OBSERVED_LABEL        added in observe mode (default cgc-observed),
 *                               so a census does not mark mail as ingested.
 *   GMAIL_REVIEW_LABEL          added to mail waiting on the review queue
 *                               (default cgc-review): an unknown sender, or
 *                               nothing the app can read. The query excludes
 *                               it, so the email is not fetched every minute;
 *                               approving the sender reads it again.
 *   GMAIL_POLL_AFTER            YYYY-MM-DD, required. Mail received before
 *                               it is never read, not even when its sender is
 *                               approved later. Without it the poller does
 *                               nothing at all (see gmailPollDisabledReason):
 *                               deploying this version with the variables the
 *                               previous poller used must not read, label or
 *                               queue the mail that poller left alone.
 *   GMAIL_INGEST_MODE           ingest (default: what the poller always did)
 *                               or observe (record who sends what, create no
 *                               invoices).
 */

import { startOfBusinessDay } from '../lib/businessDay.js';

export type GmailIngestMode = 'ingest' | 'observe';

export const DEFAULT_PROCESSED_LABEL = 'cgc-processed';
export const DEFAULT_OBSERVED_LABEL = 'cgc-observed';
export const DEFAULT_REVIEW_LABEL = 'cgc-review';

export interface GmailInboxConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Lower-cased address the token should belong to, or '' when unknown. */
  user: string;
  /** True when `user` came from GMAIL_INBOX_USER rather than GMAIL_USER. */
  userExplicit: boolean;
  invoiceLabel: string;
  processedLabel: string;
  observedLabel: string;
  reviewLabel: string;
  senderAllowlist: string[];
  trustedForwarders: string[];
  /** YYYY-MM-DD, or null when no cutoff is set. */
  pollAfter: string | null;
  /** The raw GMAIL_POLL_AFTER when it is not a real date; polling stops. */
  pollAfterInvalid: string | null;
  /** Null when GMAIL_INGEST_MODE holds something else; polling stops. */
  ingestMode: GmailIngestMode | null;
}

type EnvSource = Record<string, string | undefined>;

function pick(source: EnvSource, name: string, fallback: string): string {
  const value = source[name]?.trim();
  if (value) return value;
  return source[fallback]?.trim() ?? '';
}

/** Comma list, trimmed and lower-cased, empties dropped. */
export function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * A YYYY-MM-DD that is a real calendar date, or null.
 *
 * `2026-02-30` is refused rather than rolled over to March: a cutoff that
 * silently moves is how a backlog gets ingested.
 */
export function parsePollAfter(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.toISOString().slice(0, 10) === value ? value : null;
}

export function readGmailInboxConfig(source: EnvSource): GmailInboxConfig {
  const explicitUser = source.GMAIL_INBOX_USER?.trim() ?? '';
  const rawPollAfter = source.GMAIL_POLL_AFTER?.trim() ?? '';
  const pollAfter = rawPollAfter ? parsePollAfter(rawPollAfter) : null;
  const rawMode = source.GMAIL_INGEST_MODE?.trim().toLowerCase() ?? '';

  return {
    clientId: pick(source, 'GMAIL_INBOX_CLIENT_ID', 'GMAIL_CLIENT_ID'),
    clientSecret: pick(source, 'GMAIL_INBOX_CLIENT_SECRET', 'GMAIL_CLIENT_SECRET'),
    refreshToken: pick(source, 'GMAIL_INBOX_REFRESH_TOKEN', 'GMAIL_REFRESH_TOKEN'),
    user: pick(source, 'GMAIL_INBOX_USER', 'GMAIL_USER').toLowerCase(),
    userExplicit: explicitUser !== '',
    invoiceLabel: source.GMAIL_INVOICE_LABEL?.trim() ?? '',
    processedLabel: source.GMAIL_PROCESSED_LABEL?.trim() || DEFAULT_PROCESSED_LABEL,
    observedLabel: source.GMAIL_OBSERVED_LABEL?.trim() || DEFAULT_OBSERVED_LABEL,
    reviewLabel: source.GMAIL_REVIEW_LABEL?.trim() || DEFAULT_REVIEW_LABEL,
    senderAllowlist: parseList(source.GMAIL_SENDER_ALLOWLIST),
    // Addresses only. `@x.ca` or `x.ca` would make every mailbox at that
    // domain a forwarder whose message bodies we believe.
    trustedForwarders: parseList(source.GMAIL_TRUSTED_FORWARDERS)
      .filter(entry => /^[^@\s]+@[^@\s]+$/.test(entry)),
    pollAfter,
    pollAfterInvalid: rawPollAfter && !pollAfter ? rawPollAfter : null,
    // Unset means ingest, as today. A typo is not ingest: somebody asked for a
    // census and must not get invoices instead.
    ingestMode: rawMode === '' || rawMode === 'ingest'
      ? 'ingest'
      : rawMode === 'observe' ? 'observe' : null,
  };
}

/**
 * Why the poller must not run with this configuration, or null when it may.
 *
 * Every reason is about configuration, never a secret value, so it is safe to
 * show on the health endpoint.
 */
export function gmailPollDisabledReason(config: GmailInboxConfig): string | null {
  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    return 'Inbox credentials are not set (GMAIL_INBOX_CLIENT_ID, GMAIL_INBOX_CLIENT_SECRET, ' +
      'GMAIL_INBOX_REFRESH_TOKEN, or the GMAIL_* values they fall back to).';
  }
  if (config.ingestMode === null) {
    return 'GMAIL_INGEST_MODE must be "ingest" or "observe".';
  }
  if (config.pollAfterInvalid !== null) {
    return 'GMAIL_POLL_AFTER must be a date written YYYY-MM-DD.';
  }
  if (!config.invoiceLabel) {
    return 'GMAIL_INVOICE_LABEL is not set. Without it every unread attachment would be read as an invoice.';
  }
  const labels = [config.invoiceLabel, config.processedLabel, config.observedLabel, config.reviewLabel]
    .map(l => l.toLowerCase());
  if (new Set(labels).size !== labels.length) {
    return 'GMAIL_INVOICE_LABEL, GMAIL_PROCESSED_LABEL, GMAIL_OBSERVED_LABEL and GMAIL_REVIEW_LABEL must all differ.';
  }
  // The previous poller read unread labelled mail from GMAIL_SENDER_ALLOWLIST
  // only, left everything else unread on purpose, and did nothing with an
  // empty list. This version also knows senders from the supplier records and
  // queues the rest for review. Run on the old variables alone, it would turn
  // old unread mail from a supplier the env list never named into invoices
  // (perhaps paid by hand weeks ago) and label every other old email. So no
  // poll, in either mode, until somebody has chosen the date mail is read
  // from. This is what makes the deploy itself safe: until the date is set,
  // the new version neither reads nor labels anything.
  if (!config.pollAfter) {
    return 'GMAIL_POLL_AFTER is not set. Nothing is read or labelled until it is: set it to the go-live date ' +
      '(YYYY-MM-DD), with GMAIL_INGEST_MODE=observe to start (docs/gmail-mailbox-switch.md, step 6).';
  }
  // An empty GMAIL_SENDER_ALLOWLIST used to stop ingest mode, because the
  // list was the only thing between a labelled email and a new invoice. Mail
  // from a sender no supplier record knows now waits in the review queue and
  // never becomes an invoice, so an empty list is safe.
  return null;
}

/**
 * The Gmail search for messages still to handle.
 *
 * Gmail lists newest first and the poll reads a bounded number of pages, so
 * new mail is always seen even while older, rejected mail sits in the query.
 */
export function buildInboxQuery(config: GmailInboxConfig): string {
  const terms = [
    'has:attachment',
    `label:${JSON.stringify(config.invoiceLabel)}`,
    `-label:${JSON.stringify(config.processedLabel)}`,
    `-label:${JSON.stringify(config.reviewLabel)}`,
  ];
  if (config.ingestMode === 'observe') {
    terms.push(`-label:${JSON.stringify(config.observedLabel)}`);
  }
  if (config.pollAfter) {
    terms.push(`after:${config.pollAfter.replace(/-/g, '/')}`);
  } else {
    // The poller never gets here: it does not run without a cutoff. Kept so a
    // caller that forgets the check still cannot reach mail somebody read.
    terms.push('is:unread');
  }
  return terms.join(' ');
}

/**
 * The first moment mail is read from: the start of the GMAIL_POLL_AFTER day
 * in the business's time zone, or null when no date is set (the poller then
 * reads nothing at all). Mail before it is never read, whether the query
 * finds it or an approval re-queues it.
 */
export function readCutoff(config: Pick<GmailInboxConfig, 'pollAfter'>): Date | null {
  return config.pollAfter ? startOfBusinessDay(config.pollAfter) : null;
}
