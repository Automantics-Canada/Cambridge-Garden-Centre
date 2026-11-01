/**
 * Which email senders the app recognises, and which supplier each one is.
 *
 * The invoice inbox used to trust only GMAIL_SENDER_ALLOWLIST, a developer
 * variable that needs a redeploy to change. The client keeps no list we can
 * use (A11: the safe-senders list cannot be exported, and it is not a
 * supplier list anyway). The supplier records already say who a supplier is,
 * so they are the list:
 *
 *   Supplier.emailDomains     every address at that domain is the supplier
 *   Supplier.emailAddresses   these exact addresses are the supplier
 *   Supplier.contactEmail     this exact address is the supplier
 *   GMAIL_SENDER_ALLOWLIST    still honoured: a sender the developer listed is
 *                             known even when no supplier names it
 *
 * Shared mail services are the trap. A small trucking company or owner-operator
 * may bill from a gmail.com or hotmail.com address, and a supplier record that
 * held "gmail.com" as a domain would be credited with every Gmail user's
 * invoice. A free-mail domain therefore never identifies anyone: such senders
 * are known by their exact address only, wherever the domain came from.
 *
 * The lookup is pure (`buildKnownSenders`, `lookupSender`); `knownSenders()`
 * adds a short cache over the database read, cleared when a supplier changes.
 */
import { SupplierType } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { parseAddress } from './emailSender.js';

/**
 * Mail services where one domain is shared by unrelated people. Matched
 * exactly, plus every `yahoo.*` country domain. Canadian ISP domains are here
 * too: a yard's supplier on rogers.com is one subscriber among millions.
 *
 * The frontend keeps the same list (frontend/src/lib/emailSenders.js) so the
 * supplier form can say so before saving; tests/knownSenders.test.ts checks
 * the two agree.
 */
export const FREE_MAIL_DOMAINS: readonly string[] = [
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

/** True when the domain is shared by unrelated senders and so identifies nobody. */
export function isFreeMailDomain(domain: string | null | undefined): boolean {
  const lower = (domain ?? '').trim().toLowerCase().replace(/^@/, '');
  if (!lower) return false;
  return FREE_MAIL.has(lower) || /^yahoo\.[a-z.]+$/.test(lower);
}

const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function domainOf(address: string): string {
  return address.split('@')[1] ?? '';
}

export interface SenderEntries {
  emailDomains: string[];
  emailAddresses: string[];
  /** Entries that are neither, as typed, for the error message. */
  invalid: string[];
  /** Free-mail domains given as domains, which are refused. */
  freeMailDomains: string[];
}

/**
 * Sorts what a person typed into domains and exact addresses.
 *
 * The supplier form has one box for both, so `billing@x.example` and
 * `x.example` may arrive together in either list. An entry with an `@` is an
 * address (a leading `@x.example` is a domain); everything is lower-cased,
 * trimmed and de-duplicated. Free-mail domains are reported, not kept.
 */
export function normaliseSenderEntries(...lists: Array<readonly unknown[] | null | undefined>): SenderEntries {
  const domains = new Set<string>();
  const addresses = new Set<string>();
  const invalid: string[] = [];
  const freeMailDomains: string[] = [];
  for (const list of lists) {
    for (const raw of list ?? []) {
      if (typeof raw !== 'string') continue;
      const entry = raw.trim().toLowerCase();
      if (!entry) continue;
      if (entry.startsWith('@') || !entry.includes('@')) {
        const domain = entry.replace(/^@/, '');
        if (!DOMAIN.test(domain)) invalid.push(raw.trim());
        else if (isFreeMailDomain(domain)) freeMailDomains.push(domain);
        else domains.add(domain);
      } else if (ADDRESS.test(entry)) {
        addresses.add(entry);
      } else {
        invalid.push(raw.trim());
      }
    }
  }
  return { emailDomains: [...domains], emailAddresses: [...addresses], invalid, freeMailDomains };
}

export interface KnownSupplier {
  id: string;
  name: string;
  type: SupplierType;
}

export interface SupplierSenderRecord extends KnownSupplier {
  emailDomains: readonly string[];
  emailAddresses?: readonly string[] | null;
  contactEmail?: string | null;
}

export interface KnownSenders {
  /** Exact address → the suppliers that list it. */
  byAddress: Map<string, KnownSupplier[]>;
  /** Domain → the suppliers that list it. Never a free-mail domain. */
  byDomain: Map<string, KnownSupplier[]>;
}

function push(map: Map<string, KnownSupplier[]>, key: string, supplier: KnownSupplier) {
  const list = map.get(key) ?? [];
  if (!list.some(s => s.id === supplier.id)) list.push(supplier);
  map.set(key, list);
}

/** The lookup tables for a set of active suppliers. Pure. */
export function buildKnownSenders(suppliers: readonly SupplierSenderRecord[]): KnownSenders {
  const byAddress = new Map<string, KnownSupplier[]>();
  const byDomain = new Map<string, KnownSupplier[]>();
  for (const record of suppliers) {
    const supplier = { id: record.id, name: record.name, type: record.type };
    // emailDomains may still hold an address typed before addresses had their
    // own list, and a free-mail domain saved before the form refused one; the
    // normaliser files the first under addresses and drops the second.
    const entries = normaliseSenderEntries(record.emailDomains, record.emailAddresses ?? [], [record.contactEmail ?? '']);
    for (const address of entries.emailAddresses) push(byAddress, address, supplier);
    for (const domain of entries.emailDomains) push(byDomain, domain, supplier);
  }
  return { byAddress, byDomain };
}

export type SenderMatch = 'address' | 'domain' | 'allowlist';

export interface SenderLookup {
  /** The sender may have invoices read automatically. */
  known: boolean;
  /** The one supplier the sender belongs to, or null (unknown or ambiguous). */
  supplier: KnownSupplier | null;
  matchedBy: SenderMatch | null;
  /** More than one supplier lists the same address or domain. */
  ambiguous: boolean;
}

const UNKNOWN: SenderLookup = { known: false, supplier: null, matchedBy: null, ambiguous: false };

/** True when an env allowlist entry admits the address; free-mail domains never do. */
function allowlistAdmits(address: string, allowlist: readonly string[]): boolean {
  const domain = domainOf(address);
  return allowlist.some(raw => {
    const entry = raw.trim().toLowerCase();
    if (entry.includes('@') && !entry.startsWith('@')) return entry === address;
    const listed = entry.replace(/^@/, '');
    return listed === domain && !isFreeMailDomain(listed);
  });
}

/**
 * Who a sender is. An exact address beats a domain, so a supplier that lists
 * one person at a shared company domain wins over the company. The env
 * allowlist makes a sender known without naming a supplier.
 */
export function lookupSender(
  index: KnownSenders,
  address: string | null | undefined,
  allowlist: readonly string[] = []
): SenderLookup {
  const lower = address?.trim().toLowerCase();
  if (!lower || !ADDRESS.test(lower)) return UNKNOWN;

  const pick = (list: KnownSupplier[] | undefined, matchedBy: SenderMatch): SenderLookup | null => {
    if (!list || list.length === 0) return null;
    return { known: true, supplier: list.length === 1 ? list[0]! : null, matchedBy, ambiguous: list.length > 1 };
  };

  const domain = domainOf(lower);
  return pick(index.byAddress.get(lower), 'address')
    ?? (isFreeMailDomain(domain) ? null : pick(index.byDomain.get(domain), 'domain'))
    ?? (allowlistAdmits(lower, allowlist) ? { known: true, supplier: null, matchedBy: 'allowlist', ambiguous: false } : UNKNOWN);
}

// ------------------------------------------------------------------ cache

/**
 * How long a loaded list is reused. The poller reads it once a minute and the
 * invoice and ticket services on every email, so a short cache saves the
 * query without making a supplier edit wait. A change made in this process
 * clears it at once; the worker, a separate process, sees it within this.
 */
export const KNOWN_SENDERS_TTL_MS = 30_000;

let cached: { index: KnownSenders; loadedAt: number } | null = null;

/** Forget the cached list, after a supplier's senders change. */
export function invalidateKnownSenders(): void {
  cached = null;
}

/** The known senders from active suppliers, cached briefly. */
export async function knownSenders(now: number = Date.now()): Promise<KnownSenders> {
  if (cached && now - cached.loadedAt < KNOWN_SENDERS_TTL_MS) return cached.index;
  const suppliers = await prisma.supplier.findMany({
    where: { active: true },
    select: { id: true, name: true, type: true, emailDomains: true, emailAddresses: true, contactEmail: true },
  });
  cached = { index: buildKnownSenders(suppliers), loadedAt: now };
  return cached.index;
}

/**
 * The supplier a From-style value belongs to, or null. Accepts
 * `Name <a@b>`, `"Name" a@b` or a bare address, parsed the way the inbox
 * poller parses it (the last address wins, so a display name cannot pose as
 * a supplier).
 */
export async function findSupplierForSender(from: string | null | undefined): Promise<KnownSupplier | null> {
  const address = parseAddress(from ?? null);
  if (!address) return null;
  return lookupSender(await knownSenders(), address).supplier;
}
