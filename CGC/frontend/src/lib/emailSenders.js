/**
 * Email senders on the supplier form and the review queue.
 *
 * Same rules as the backend (services/knownSenders.ts): a supplier is known by
 * its email domains and by exact addresses. A free-mail domain such as
 * gmail.com is shared by millions of people, so it never identifies a
 * supplier; a supplier on one is entered by its full address. The backend
 * test tests/knownSenders.test.ts checks this list matches its own.
 */
export const FREE_MAIL_DOMAINS = [
  'gmail.com', 'googlemail.com',
  'outlook.com', 'outlook.ca', 'hotmail.com', 'hotmail.ca', 'live.com', 'live.ca', 'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'ymail.com', 'rocketmail.com',
  'protonmail.com', 'proton.me', 'pm.me',
  'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'zoho.com', 'fastmail.com', 'hushmail.com',
  'rogers.com', 'sympatico.ca', 'bell.net', 'cogeco.ca', 'shaw.ca', 'telus.net', 'videotron.ca',
  'eastlink.ca', 'execulink.com', 'start.ca', 'teksavvy.com',
];

const FREE_MAIL = new Set(FREE_MAIL_DOMAINS);
const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** True when the domain is shared by unrelated senders (gmail.com, yahoo.ca…). */
export function isFreeMailDomain(domain) {
  const lower = String(domain ?? '').trim().toLowerCase().replace(/^@/, '');
  if (!lower) return false;
  return FREE_MAIL.has(lower) || /^yahoo\.[a-z.]+$/.test(lower);
}

export function domainOf(address) {
  return String(address ?? '').toLowerCase().split('@')[1] ?? '';
}

/**
 * Sorts the "domains or addresses" box into the two lists the API takes.
 * Returns the entries it could not accept, and the free-mail domains, so the
 * form can say what is wrong.
 */
export function splitSenderEntries(text) {
  const emailDomains = [];
  const emailAddresses = [];
  const invalid = [];
  const freeMailDomains = [];
  for (const raw of String(text ?? '').split(/[,;\s]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith('@') || !entry.includes('@')) {
      const domain = entry.replace(/^@/, '');
      if (!DOMAIN.test(domain)) invalid.push(raw.trim());
      else if (isFreeMailDomain(domain)) freeMailDomains.push(domain);
      else if (!emailDomains.includes(domain)) emailDomains.push(domain);
    } else if (ADDRESS.test(entry)) {
      if (!emailAddresses.includes(entry)) emailAddresses.push(entry);
    } else {
      invalid.push(raw.trim());
    }
  }
  return { emailDomains, emailAddresses, invalid, freeMailDomains };
}

/** The box's text for a saved supplier: domains first, then addresses. */
export function joinSenderEntries(supplier) {
  return [...(supplier?.emailDomains ?? []), ...(supplier?.emailAddresses ?? [])].join(', ');
}

/** The form's error for the box, or null when every entry is usable. */
export function senderEntriesError(text) {
  const { invalid, freeMailDomains } = splitSenderEntries(text);
  if (freeMailDomains.length > 0) {
    const domain = freeMailDomains[0];
    return `${domain} is shared by many senders. Enter the full address instead, e.g. name@${domain}.`;
  }
  if (invalid.length > 0) {
    return `Not a domain or email address: ${invalid.join(', ')}`;
  }
  return null;
}

/**
 * Whether this role may set a supplier's email senders and contact email.
 * They decide whose invoices the inbox reads automatically, as approving a
 * sender does, so they are for owners and admins; the server refuses them
 * from anyone else.
 */
export function canSetSupplierSenders(role) {
  return role === 'OWNER' || role === 'ADMIN';
}
