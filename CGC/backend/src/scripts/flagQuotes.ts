/**
 * Marks the quotations already stored as QUOTE.
 *
 * The import recognises a quotation from now on (a document on Item Tracking,
 * entered inside the Order Report's range but left off it, with no history).
 * Documents imported before that are stored as ordinary orders, at best
 * flagged NOT_OPEN. This finds the stored ones the same rule would call a
 * quotation and, only when asked, flags them.
 *
 * Usage (from CGC/backend, run by a person):
 *
 *   DATABASE_URL=... npm run quotes:flag
 *       Dry run. Prints the database host and name, then every document it
 *       would flag, with its flags before and after. Changes nothing.
 *
 *   DATABASE_URL=... npm run quotes:flag -- --apply
 *       Writes, but only to a loopback database (127.0.0.1, localhost, ::1).
 *
 *   DATABASE_URL=... npm run quotes:flag -- --apply --confirm-host=<host>
 *       Writes to any other database, when <host> equals the host in
 *       DATABASE_URL exactly, so a command copied from one environment cannot
 *       run against another. Production needs a reviewed dry run and approval
 *       first.
 *
 *   --documents=2610-000001,2610-000002
 *       Only these documents (the ones the client confirmed are quotations).
 *
 * A stored document is a quotation candidate when:
 *   - an upload has carried it on Item Tracking, and never on the Order Report
 *     or the Delivery Report;
 *   - none of its lines has a supplier PO;
 *   - it has no stop, and no line has a driver, an invoice or a ticket.
 * Writing adds QUOTE, drops NOT_OPEN (the two say different things about the
 * same document; the import sets one or the other) and the state flags the
 * import never raises on a quotation (no address, no phone, ...), and sets
 * isPickup false.
 * Nothing is deleted. To undo, put back the "before" flags this prints.
 *
 * DATABASE_URL must be set in the environment: the database is never read
 * from a .env file, so the script cannot pick up one nobody named.
 */
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';

import { ORDER_FLAGS, STATE_FLAGS } from '../modules/orders/import/mergeOrderFacts.js';

const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]'];

const USAGE =
  'Usage: DATABASE_URL=... npm run quotes:flag -- [--apply] [--confirm-host=<host>] [--documents=a,b]\n' +
  '       --apply writes only to a loopback database, or to the host --confirm-host names exactly.';

export class Refusal extends Error {}

export interface Options {
  apply: boolean;
  confirmHost: string | null;
  documents: string[] | null;
  help: boolean;
}

export function parseOptions(argv: string[]): Options {
  const options: Options = { apply: false, confirmHost: null, documents: null, help: false };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--confirm-host=')) options.confirmHost = arg.slice('--confirm-host='.length).trim() || null;
    else if (arg.startsWith('--documents=')) {
      const documents = arg.slice('--documents='.length).split(',').map(value => value.trim()).filter(Boolean);
      if (documents.length === 0) throw new Refusal(`--documents names no document.\n${USAGE}`);
      options.documents = documents;
    } else throw new Refusal(`Unknown argument: ${arg}\n${USAGE}`);
  }
  return options;
}

/** Host, port and database — never the user, password or full URL. */
export function describeTarget(rawUrl: string | undefined): { host: string; port: string; database: string } {
  if (!rawUrl) throw new Refusal(`DATABASE_URL is not set.\n${USAGE}`);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Refusal('DATABASE_URL is not a valid URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Refusal('DATABASE_URL is not a PostgreSQL URL.');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!url.hostname || !database) throw new Refusal('DATABASE_URL must name a host and a database.');
  return { host: url.hostname, port: url.port || '5432', database };
}

/** Throws unless a write to `host` was asked for in a way that names it. */
export function assertMayWrite(host: string, confirmHost: string | null): void {
  if (LOOPBACK.includes(host)) return;
  if (confirmHost === host) return;
  throw new Refusal(
    `Refusing --apply: ${host} is not a loopback database, so --confirm-host must equal it exactly. ` +
      (confirmHost ? 'It does not.' : 'It is not set.')
  );
}

export interface StoredDocument {
  id: string;
  documentNumber: string;
  customerName: string;
  orderDate: Date | null;
  deliveryDate: Date | null;
  flags: string[];
  sourceReports: string[];
  isPickup: boolean;
  delivery: { id: string } | null;
  lines: Array<{
    poNumber: string | null;
    driverId: string | null;
    hasInvoice: boolean;
    _count: { deliveries: number; tickets: number; lineItems: number; ticketMatches: number };
  }>;
}

/** The import's quotation rule, applied to what is stored. */
export function isQuoteCandidate(document: StoredDocument): boolean {
  if (document.flags.includes('QUOTE')) return false;
  if (!document.sourceReports.includes('ITEM_TRACKING')) return false;
  if (document.sourceReports.includes('ORDER_SUMMARY') || document.sourceReports.includes('DELIVERY')) return false;
  if (document.delivery) return false;
  return document.lines.every(line =>
    !line.poNumber?.trim() && line.driverId === null && !line.hasInvoice &&
    line._count.deliveries === 0 && line._count.tickets === 0 &&
    line._count.lineItems === 0 && line._count.ticketMatches === 0
  );
}

/**
 * QUOTE in, NOT_OPEN out, and the flags read off the order's state out too
 * (no address, no phone, ...): the import raises none of them on a quotation,
 * which is going nowhere, so leaving them would show it as needing attention.
 * Every other flag is kept. In the vocabulary's order, as the import stores
 * them, so the next import does not rewrite them.
 */
export function quoteFlags(flags: readonly string[]): string[] {
  const vocabulary: readonly string[] = ORDER_FLAGS;
  const dropped: readonly string[] = ['NOT_OPEN', ...STATE_FLAGS];
  const all = new Set([...flags.filter(flag => !dropped.includes(flag)), 'QUOTE']);
  return [...vocabulary.filter(flag => all.has(flag)), ...flags.filter(flag => !vocabulary.includes(flag))];
}

export interface PlannedQuote {
  id: string;
  documentNumber: string;
  customerName: string;
  orderDate: string | null;
  deliveryDate: string | null;
  lineCount: number;
  before: string[];
  after: string[];
}

type Db = Pick<PrismaClient, 'orderDocument'>;

const isoDay = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

export async function planQuoteFlags(db: Db, documents: string[] | null = null): Promise<PlannedQuote[]> {
  const stored = await db.orderDocument.findMany({
    where: {
      sourceReports: { has: 'ITEM_TRACKING' },
      NOT: [{ sourceReports: { hasSome: ['ORDER_SUMMARY', 'DELIVERY'] } }, { flags: { has: 'QUOTE' } }],
      ...(documents ? { documentNumber: { in: documents } } : {}),
    },
    orderBy: { documentNumber: 'asc' },
    select: {
      id: true,
      documentNumber: true,
      customerName: true,
      orderDate: true,
      deliveryDate: true,
      flags: true,
      sourceReports: true,
      isPickup: true,
      delivery: { select: { id: true } },
      lines: {
        select: {
          poNumber: true,
          driverId: true,
          hasInvoice: true,
          _count: { select: { deliveries: true, tickets: true, lineItems: true, ticketMatches: true } },
        },
      },
    },
  });

  return stored.filter(isQuoteCandidate).map(document => ({
    id: document.id,
    documentNumber: document.documentNumber,
    customerName: document.customerName,
    orderDate: isoDay(document.orderDate),
    deliveryDate: isoDay(document.deliveryDate),
    lineCount: document.lines.length,
    before: document.flags,
    after: quoteFlags(document.flags),
  }));
}

/**
 * Writes the plan, one document at a time. A document whose flags changed
 * since the plan was made (an upload ran meanwhile) is skipped, not
 * overwritten: run the dry run again.
 */
export async function applyQuoteFlags(db: Db, plan: PlannedQuote[]): Promise<{ written: number; skipped: string[] }> {
  let written = 0;
  const skipped: string[] = [];
  for (const item of plan) {
    const result = await db.orderDocument.updateMany({
      where: { id: item.id, flags: { equals: item.before } },
      data: { flags: item.after, isPickup: false },
    });
    if (result.count === 1) written++;
    else skipped.push(item.documentNumber);
  }
  return { written, skipped };
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  // Read before Prisma is loaded, which may read a .env file into the environment.
  const rawUrl = process.env.DATABASE_URL;
  const target = describeTarget(rawUrl);
  console.log(`Database: host=${target.host} port=${target.port} database=${target.database}`);
  console.log(`Mode: ${options.apply ? 'APPLY' : 'DRY RUN (nothing is changed; pass --apply to write)'}`);
  if (options.documents) console.log(`Only: ${options.documents.join(', ')}`);
  if (options.apply) assertMayWrite(target.host, options.confirmHost);

  const { PrismaClient } = await import('@prisma/client');
  // describeTarget has refused an unset URL, so rawUrl is a string here.
  const prisma = new PrismaClient({ datasourceUrl: rawUrl!, log: [] });
  try {
    const plan = await planQuoteFlags(prisma, options.documents);
    console.log(`\nQuotation candidates: ${plan.length}`);
    for (const item of plan) {
      console.log(
        `  ${item.documentNumber}  ${item.customerName}  entered ${item.orderDate ?? '?'}  ` +
          `delivery ${item.deliveryDate ?? 'none'}  ${item.lineCount} line(s)\n` +
          `      flags before: [${item.before.join(', ')}]  after: [${item.after.join(', ')}]`
      );
    }

    if (!options.apply) {
      console.log(plan.length > 0 ? `\nDry run. Nothing was changed.` : '\nDry run. Nothing to flag.');
      return 0;
    }

    const { written, skipped } = await applyQuoteFlags(prisma, plan);
    console.log(`\nFlagged ${written} document(s) QUOTE.`);
    if (skipped.length > 0) {
      console.log(`Skipped, because their flags changed since they were read: ${skipped.join(', ')}. Run again.`);
    }
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    code => process.exit(code),
    (error: unknown) => {
      if (error instanceof Refusal) {
        console.error(error.message);
        process.exit(2);
      }
      // Prisma's messages name the host and user at most, never the password.
      console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  );
}
