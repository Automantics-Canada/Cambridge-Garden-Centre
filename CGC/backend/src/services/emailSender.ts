/**
 * Who actually sent an email that reached the invoice inbox.
 *
 * Supplier invoices go to ap@cambridgegardencentre.ca (Microsoft 365), which
 * forwards them to the Gmail inbox the app polls. How the forward was set up
 * decides what the copy looks like:
 *
 *   direct    sent straight to the Gmail inbox. From is the sender.
 *   redirect  M365 mailbox forwarding, or an Inbox rule "Redirect to". From is
 *             still the supplier; Resent-*, X-MS-Exchange-Inbox-Rules-Loop,
 *             an SRS Return-Path or the original To name the AP mailbox.
 *   forward   an Inbox rule "Forward to". A new message From the AP mailbox,
 *             usually "FW: ...". The supplier appears only in the quoted
 *             header block of the body ("From: Name <address>").
 *   unknown   none of the above could be established.
 *
 * The sender allowlist is checked against `originalSender`, so forwarded
 * supplier mail passes and a message the AP mailbox wrote itself does not.
 *
 * Fails closed. A message From a trusted forwarder is only a forward when
 * Gmail authenticated the forwarder AND the body names an original sender;
 * otherwise it is `unknown`, and unknown is never an allowed supplier. The
 * forwarded header block is text anybody can type, so it is believed only from
 * a mailbox we chose to trust, and only when that mailbox really sent it.
 *
 * Pure: no configuration, database or network. The caller passes the trusted
 * forwarders, so the review queue that comes later can reuse it unchanged.
 */

export type SenderMode = 'direct' | 'redirect' | 'forward' | 'unknown';

export interface ResolvedSender {
  /** Lower-cased address of whoever wrote the message, or null when unknown. */
  originalSender: string | null;
  /** Lower-cased trusted forwarder that relayed it, or null. */
  forwardedBy: string | null;
  mode: SenderMode;
  /** A short plain sentence saying how this was decided, for logs and the census. */
  reason: string;
}

export interface ResolveSenderOptions {
  /** Lower-cased full addresses, e.g. the AP mailbox. */
  trustedForwarders?: readonly string[];
  /**
   * Require Gmail's own Authentication-Results to show the forwarder really
   * sent a 'forward'. On by default; only a test or a caller that has already
   * authenticated the message should turn it off.
   */
  requireForwarderAuth?: boolean;
}

export type HeaderList =
  | ReadonlyArray<{ name?: string | null; value?: string | null }>
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export type MessageBody = string | { text?: string | null; html?: string | null };

const ADDRESS = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;

/** Every value of a header, case-insensitively, in message order. */
export function headerValues(headers: HeaderList, name: string): string[] {
  const wanted = name.toLowerCase();
  if (Array.isArray(headers)) {
    return (headers as ReadonlyArray<{ name?: string | null; value?: string | null }>)
      .filter(h => (h.name ?? '').toLowerCase() === wanted && typeof h.value === 'string')
      .map(h => h.value as string);
  }
  const record = headers as Readonly<Record<string, string | readonly string[] | undefined>>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    return typeof value === 'string' ? [value] : [...value];
  }
  return [];
}

/**
 * The address in a From-style value: `Name <a@b>`, `Name [mailto:a@b]`,
 * `"Name" a@b` or a bare `a@b`. Lower-cased; null when there is none.
 */
export function parseAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const bracketed = /<([^<>\s]+@[^<>\s]+)>/.exec(value)?.[1]
    ?? /\[mailto:([^\]\s]+)\]/i.exec(value)?.[1];
  const candidate = bracketed ?? ADDRESS.exec(value)?.[0];
  if (!candidate) return null;
  const address = candidate.replace(/^mailto:/i, '').trim().toLowerCase();
  return ADDRESS.test(address) ? address : null;
}

/** Every address in a To/Cc-style value. */
function parseAddresses(value: string): string[] {
  return (value.match(new RegExp(ADDRESS.source, 'gi')) ?? []).map(a => a.toLowerCase());
}

function domainOf(address: string): string {
  return address.split('@')[1] ?? '';
}

/**
 * True when the address is on a sender list of addresses and domains. An
 * entry matches the full address, its domain, or `@domain`. An empty list or
 * a missing address matches nothing.
 */
export function matchesSenderList(address: string | null, list: readonly string[]): boolean {
  if (!address) return false;
  const lower = address.toLowerCase();
  const domain = domainOf(lower);
  return list.some(entry => entry === lower || entry === domain || (entry.startsWith('@') && entry.slice(1) === domain));
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Separator the HTML conversion leaves where Outlook draws its rule. */
const OUTLOOK_RULE = '________________________________';

/**
 * Plain text from an HTML body, keeping the line structure the forwarded
 * header block depends on. Tags are removed before entities are decoded, so
 * `&lt;billing@x&gt;` survives as `<billing@x>`.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    // Outlook separates the forwarded block with an <hr> (or the
    // divRplyFwdMsg container), which would otherwise vanish with the tags.
    .replace(/<hr\b[^>]*>/gi, `\n${OUTLOOK_RULE}\n`)
    .replace(/<div\b[^>]*id=["']?divRplyFwdMsg[^>]*>/gi, `\n${OUTLOOK_RULE}\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
      if (code[0] === '#') {
        const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
      }
      return ENTITIES[code.toLowerCase()] ?? whole;
    })
    .replace(/ /g, ' ')
    .replace(/\r\n?/g, '\n');
}

const SEPARATORS = [
  /^[ \t>]*-{2,}\s*Original Message\s*-{2,}[ \t]*$/im,
  /^[ \t>]*_{10,}[ \t]*$/m,
  /^[ \t>]*-{3,}\s*Forwarded message\s*-{3,}[ \t]*$/im,
  /^[ \t>]*Begin forwarded message:[ \t]*$/im,
];

/** How many lines after the separator the header block may take. */
const BLOCK_LINES = 12;

/**
 * The original sender named in the first forwarded header block, or null.
 *
 * The first block is the message that was forwarded; any further blocks are
 * older replies quoted inside it. A "From:" line counts only inside a block
 * that also has a Sent/Date/To/Subject line, so a sentence that happens to
 * begin "From:" is not mistaken for a header.
 *
 * Only the English labels Outlook uses are recognised. A mailbox set to
 * another language writes "De:" or "Von:", which reads as unknown: it fails
 * closed rather than guessing.
 */
export function findForwardedFrom(text: string): string | null {
  const normalised = text.replace(/\r\n?/g, '\n');
  let start = -1;
  for (const separator of SEPARATORS) {
    const match = separator.exec(normalised);
    if (match && (start === -1 || match.index < start)) start = match.index + match[0].length;
  }
  if (start === -1) return null;

  const lines = normalised.slice(start).split('\n')
    .map(line => line.replace(/^[ \t>]+/, '').replace(/\*/g, '').trim())
    .filter(line => line !== '')
    .slice(0, BLOCK_LINES);

  const fromLine = lines.find(line => /^From:/i.test(line));
  const looksLikeHeaders = lines.some(line => /^(Sent|Date|To|Subject):/i.test(line));
  if (!fromLine || !looksLikeHeaders) return null;
  return parseAddress(fromLine.replace(/^From:/i, ''));
}

function bodyCandidates(body: MessageBody | undefined): string[] {
  if (body === undefined) return [];
  if (typeof body === 'string') {
    return [/<(html|body|div|p|br|table|span|hr)\b/i.test(body) ? htmlToText(body) : body];
  }
  const out: string[] = [];
  if (body.text) out.push(body.text);
  if (body.html) out.push(htmlToText(body.html));
  return out;
}

/**
 * True when Gmail's own Authentication-Results say the forwarder's domain
 * sent this message: DMARC passed for it, DKIM passed for it, or SPF passed
 * for an envelope sender at it.
 *
 * Only the topmost header stamped by mx.google.com counts. Anything below it
 * was already in the message when it arrived, and a sender can write any
 * Authentication-Results it likes.
 */
export function forwarderAuthenticated(headers: HeaderList, forwarder: string): boolean {
  const domain = domainOf(forwarder);
  if (!domain) return false;
  const results = headerValues(headers, 'Authentication-Results')
    .find(value => /^\s*mx\.google\.com\s*;/i.test(value));
  if (!results) return false;

  const lower = results.toLowerCase();
  const sameDomain = (value: string | undefined) =>
    value !== undefined && value.replace(/^@/, '').split('@').pop() === domain;

  const dmarc = /\bdmarc=pass\b[^;]*?\bheader\.from=([^\s;]+)/.exec(lower)?.[1];
  if (sameDomain(dmarc)) return true;
  for (const match of lower.matchAll(/\bdkim=pass\b[^;]*?\bheader\.(?:i|d)=([^\s;]+)/g)) {
    if (sameDomain(match[1])) return true;
  }
  const spf = /\bspf=pass\b[^;]*?\bsmtp\.mailfrom=([^\s;]+)/.exec(lower)?.[1];
  return sameDomain(spf);
}

/** Headers that, naming a trusted forwarder, show the message was relayed. */
const RELAY_HEADERS = ['Resent-From', 'Resent-Sender', 'X-MS-Exchange-Inbox-Rules-Loop', 'X-Forwarded-For'];
/** Weaker evidence: the message was addressed to the forwarder. */
const RECIPIENT_HEADERS = ['To', 'Cc', 'X-Original-To'];

function findRelay(headers: HeaderList, forwarders: readonly string[]): { by: string; header: string } | null {
  for (const header of RELAY_HEADERS) {
    for (const value of headerValues(headers, header)) {
      const by = parseAddresses(value).find(a => forwarders.includes(a));
      if (by) return { by, header };
    }
  }
  // Exchange's Sender Rewriting Scheme puts the forwarding domain in the
  // envelope sender: <bounces+SRS=...@forwarder-domain>.
  for (const value of headerValues(headers, 'Return-Path')) {
    const address = parseAddress(value);
    if (!address || !/^(bounces\+)?srs[0-9]?[=+]/i.test(address)) continue;
    const by = forwarders.find(f => domainOf(f) === domainOf(address));
    if (by) return { by, header: 'Return-Path' };
  }
  for (const header of RECIPIENT_HEADERS) {
    for (const value of headerValues(headers, header)) {
      const by = parseAddresses(value).find(a => forwarders.includes(a));
      if (by) return { by, header };
    }
  }
  return null;
}

export function resolveSender(
  headers: HeaderList,
  body?: MessageBody,
  options: ResolveSenderOptions = {}
): ResolvedSender {
  const forwarders = (options.trustedForwarders ?? []).map(f => f.toLowerCase());
  const requireAuth = options.requireForwarderAuth ?? true;
  const from = parseAddress(headerValues(headers, 'From')[0]);

  if (!from) {
    return { originalSender: null, forwardedBy: null, mode: 'unknown', reason: 'The message has no From address.' };
  }

  if (forwarders.includes(from)) {
    if (requireAuth && !forwarderAuthenticated(headers, from)) {
      return {
        originalSender: null,
        forwardedBy: from,
        mode: 'unknown',
        reason: `From ${from}, but Gmail did not authenticate it as that mailbox.`,
      };
    }
    for (const text of bodyCandidates(body)) {
      const original = findForwardedFrom(text);
      if (!original) continue;
      if (forwarders.includes(original)) {
        return {
          originalSender: null,
          forwardedBy: from,
          mode: 'unknown',
          reason: `Forwarded by ${from}, but the forwarded message is from a forwarder too.`,
        };
      }
      return { originalSender: original, forwardedBy: from, mode: 'forward', reason: `Forwarded by ${from}.` };
    }
    return {
      originalSender: null,
      forwardedBy: from,
      mode: 'unknown',
      reason: `From ${from}, but no original sender was found in the forwarded message.`,
    };
  }

  const relay = findRelay(headers, forwarders);
  if (relay) {
    return {
      originalSender: from,
      forwardedBy: relay.by,
      mode: 'redirect',
      reason: `Redirected by ${relay.by} (${relay.header}).`,
    };
  }

  return { originalSender: from, forwardedBy: null, mode: 'direct', reason: 'Sent directly.' };
}
