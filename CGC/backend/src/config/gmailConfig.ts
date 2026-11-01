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
 *   GMAIL_SENDER_ALLOWLIST      comma list of sender domains or addresses.
 *                               Required in ingest mode, matched against the
 *                               original sender (see services/emailSender.ts).
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
 *   GMAIL_POLL_AFTER            YYYY-MM-DD. Mail received before it is never
 *                               read. Without it the query also keeps
 *                               `is:unread`, as before, so turning this version
 *                               on cannot reach back into mail somebody already
 *                               read or paid.
 *   GMAIL_INGEST_MODE           ingest (default: what the poller always did)
 *                               or observe (record who sends what, create no
 *                               invoices).
 */

export type GmailIngestMode = 'ingest' | 'observe';

export const DEFAULT_PROCESSED_LABEL = 'cgc-processed';
export const DEFAULT_OBSERVED_LABEL = 'cgc-observed';

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
  const labels = [config.invoiceLabel, config.processedLabel, config.observedLabel].map(l => l.toLowerCase());
  if (new Set(labels).size !== labels.length) {
    return 'GMAIL_INVOICE_LABEL, GMAIL_PROCESSED_LABEL and GMAIL_OBSERVED_LABEL must all differ.';
  }
  if (config.ingestMode === 'ingest' && config.senderAllowlist.length === 0) {
    return 'GMAIL_SENDER_ALLOWLIST is empty, so ingest mode would accept no sender. ' +
      'Use GMAIL_INGEST_MODE=observe to record who sends mail first.';
  }
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
  ];
  if (config.ingestMode === 'observe') {
    terms.push(`-label:${JSON.stringify(config.observedLabel)}`);
  }
  if (config.pollAfter) {
    terms.push(`after:${config.pollAfter.replace(/-/g, '/')}`);
  } else {
    terms.push('is:unread');
  }
  return terms.join(' ');
}
