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
 *       would flag, with its entry date, the Order Report ranges it was
 *       uploaded with, and its flags before and after; and the documents it
 *       leaves alone because no such range covers their entry date. Changes
 *       nothing.
 *
 *   DATABASE_URL=... npm run quotes:flag -- --apply
 *       Writes, but only to a loopback database (127.0.0.1, localhost, ::1).
 *
 *   DATABASE_URL=... npm run quotes:flag -- --apply --confirm-host=<host> --documents=a,b
 *       Writes to any other database, when <host> equals the host in
 *       DATABASE_URL exactly, so a command copied from one environment cannot
 *       run against another, and only to the documents named: there, every
 *       document flagged is one a person picked from a reviewed dry run.
 *       Production needs that review and approval first.
 *
 *   --documents=2610-000001,2610-000002
 *       Only these documents (the ones the client confirmed are quotations).
 *
 * A stored document is a quotation candidate when, as the import decides it:
 *   - an upload has carried it on Item Tracking, and never on the Order Report
 *     or the Delivery Report;
 *   - an upload that carried it on Item Tracking also had an Order Report
 *     whose printed range covers the document's entry date, and that report
 *     did not name it even on a line it could not read. Entered outside every
 *     such range, the Order Report was never going to list it (an order still
 *     open, say), so nothing can be concluded and it is left alone;
 *   - none of its lines has a supplier PO;
 *   - it has no stop, and no line has a driver, an invoice or a ticket;
 *   - the office has not marked it "Not a quotation".
 * Writing adds QUOTE, drops NOT_OPEN (the two say different things about the
 * same document; the import sets one or the other) and the state flags the
 * import never raises on a quotation (no address, no phone, ...), and sets
 * isPickup false.
 *
 * Nothing is deleted, and every flag written can be taken back: "Not a
 * quotation" on the order (Orders page, Quotations) takes QUOTE off, works out
 * again whether it is a pickup and which state flags it has, and keeps later
 * uploads from calling it a quotation.
 *
 * DATABASE_URL must be set in the environment: the database is never read
 * from a .env file, so the script cannot pick up one nobody named.
 */
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';

import { ORDER_FLAGS, STATE_FLAGS } from '../modules/orders/import/mergeOrderFacts.js';
import { NOT_A_QUOTE_FLAG } from '../modules/orders/quotations.js';

const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]'];

const USAGE =
  'Usage: DATABASE_URL=... npm run quotes:flag -- [--apply] [--confirm-host=<host>] [--documents=a,b]\n' +
  '       --apply writes only to a loopback database, or to the host --confirm-host names exactly\n' +
  '       and then only to the documents --documents names.';

/** How a flag written here is taken back, said wherever the script writes. */
export const UNDO =
  'To undo one: open the order (Orders page, Quotations) and choose "Not a quotation". ' +
  'That takes QUOTE off, works out again whether it is a pickup and its flags, and keeps later uploads from flagging it.';

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

/**
 * Throws unless a write to `host` was asked for in a way that names it, and,
 * away from a loopback database, names the documents too: there the dry
 * run's list is for a person to review, not to apply wholesale.
 */
export function assertMayWrite(host: string, confirmHost: string | null, documents: string[] | null): void {
  if (LOOPBACK.includes(host)) return;
  if (confirmHost !== host) {
    throw new Refusal(
      `Refusing --apply: ${host} is not a loopback database, so --confirm-host must equal it exactly. ` +
        (confirmHost ? 'It does not.' : 'It is not set.')
    );
  }
  if (!documents) {
    throw new Refusal(
      `Refusing --apply: ${host} is not a loopback database, so --documents must name the documents to flag, ` +
        'picked from a reviewed dry run.'
    );
  }
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

/**
 * An Order Report range a document was uploaded with: an upload that carried
 * the document on Item Tracking and had an Order Report printed for these
 * entry dates, which did not list it. 'YYYY-MM-DD' days.
 */
export interface Coverage {
  dispatchDate: string;
  from: string;
  to: string;
}

const isoDay = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

/**
 * Whether the document was entered inside an Order Report range it was
 * uploaded with: only then did the Order Report leaving it out say anything.
 */
export function enteredInCoverage(orderDate: Date | null, coverage: readonly Coverage[]): boolean {
  const entered = isoDay(orderDate);
  return entered !== null && coverage.some(range => entered >= range.from && entered <= range.to);
}

/**
 * The import's quotation rule, applied to what is stored, apart from the
 * entry date (`enteredInCoverage`). The office's "Not a quotation" holds here
 * as in the import.
 */
export function isQuoteCandidate(document: StoredDocument): boolean {
  if (document.flags.includes('QUOTE') || document.flags.includes(NOT_A_QUOTE_FLAG)) return false;
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
  /** The Order Report ranges it was uploaded with. */
  coverage: Coverage[];
  isPickup: boolean;
  before: string[];
  after: string[];
}

export interface QuotePlan {
  /** What --apply would flag. */
  flag: PlannedQuote[];
  /**
   * Only on Item Tracking and nothing ever happened to it, but entered
   * outside every Order Report range it was uploaded with: an open order
   * looks the same, so it is left alone.
   */
  notJudged: PlannedQuote[];
}

type Db = Pick<PrismaClient, 'orderDocument' | 'importBatch'>;

interface StoredExtraction {
  rows?: Array<{ documentNumber?: unknown }>;
  unreadable?: Array<{ documentNumber?: unknown }>;
}

const numbersIn = (list: StoredExtraction['rows']) =>
  new Set((Array.isArray(list) ? list : []).map(row => row?.documentNumber).filter((value): value is string => typeof value === 'string'));

/**
 * The Order Report ranges each document was uploaded with, read from the
 * uploads themselves: the Item Tracking rows each one kept, and its Order
 * Report's printed range. One upload at a time, since each holds its rows.
 */
export async function orderReportCoverage(db: Db, documentNumbers: ReadonlySet<string>): Promise<Map<string, Coverage[]>> {
  const coverage = new Map<string, Coverage[]>();
  if (documentNumbers.size === 0) return coverage;
  const batches = await db.importBatch.findMany({
    where: {
      status: 'DONE',
      files: { some: { reportType: 'ORDER_SUMMARY', reportDateFrom: { not: null }, reportDateTo: { not: null } } },
    },
    orderBy: [{ dispatchDate: 'asc' }, { createdAt: 'asc' }],
    select: { id: true },
  });

  for (const { id } of batches) {
    const batch = await db.importBatch.findUniqueOrThrow({
      where: { id },
      select: {
        dispatchDate: true,
        files: { select: { reportType: true, reportDateFrom: true, reportDateTo: true, extraction: true } },
      },
    });
    const summary = batch.files.find(file => file.reportType === 'ORDER_SUMMARY');
    const tracking = batch.files.find(file => file.reportType === 'ITEM_TRACKING');
    if (!summary?.reportDateFrom || !summary.reportDateTo || !tracking) continue;

    const onTracking = numbersIn((tracking.extraction as StoredExtraction | null)?.rows);
    // A document the Order or Delivery Report names, even on a line it could
    // not read, is on that report: the import never judged it, nor does this.
    const named = new Set<string>();
    for (const file of batch.files) {
      if (file.reportType === 'ITEM_TRACKING') continue;
      const extraction = file.extraction as StoredExtraction | null;
      for (const number of numbersIn(extraction?.rows)) named.add(number);
      for (const number of numbersIn(extraction?.unreadable)) named.add(number);
    }

    const range: Coverage = {
      dispatchDate: isoDay(batch.dispatchDate)!,
      from: isoDay(summary.reportDateFrom)!,
      to: isoDay(summary.reportDateTo)!,
    };
    for (const number of onTracking) {
      if (!documentNumbers.has(number) || named.has(number)) continue;
      coverage.set(number, [...(coverage.get(number) ?? []), range]);
    }
  }
  return coverage;
}

export async function planQuoteFlags(db: Db, documents: string[] | null = null): Promise<QuotePlan> {
  const stored = await db.orderDocument.findMany({
    where: {
      sourceReports: { has: 'ITEM_TRACKING' },
      NOT: [{ sourceReports: { hasSome: ['ORDER_SUMMARY', 'DELIVERY'] } }, { flags: { hasSome: ['QUOTE', NOT_A_QUOTE_FLAG] } }],
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

  const candidates = stored.filter(isQuoteCandidate);
  const coverage = await orderReportCoverage(db, new Set(candidates.map(document => document.documentNumber)));
  const plan: QuotePlan = { flag: [], notJudged: [] };
  for (const document of candidates) {
    const ranges = coverage.get(document.documentNumber) ?? [];
    const item: PlannedQuote = {
      id: document.id,
      documentNumber: document.documentNumber,
      customerName: document.customerName,
      orderDate: isoDay(document.orderDate),
      deliveryDate: isoDay(document.deliveryDate),
      lineCount: document.lines.length,
      coverage: ranges,
      isPickup: document.isPickup,
      before: document.flags,
      after: quoteFlags(document.flags),
    };
    (enteredInCoverage(document.orderDate, ranges) ? plan.flag : plan.notJudged).push(item);
  }
  return plan;
}

/** "10/20 to 10/22 (upload for 10/22)", or "none" for no Order Report. */
export function describeCoverage(coverage: readonly Coverage[]): string {
  if (coverage.length === 0) return 'none uploaded with it';
  return coverage.map(range => `${range.from} to ${range.to} (upload for ${range.dispatchDate})`).join('; ');
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
  if (options.apply) assertMayWrite(target.host, options.confirmHost, options.documents);

  const { PrismaClient } = await import('@prisma/client');
  // describeTarget has refused an unset URL, so rawUrl is a string here.
  const prisma = new PrismaClient({ datasourceUrl: rawUrl!, log: [] });
  try {
    const { flag, notJudged } = await planQuoteFlags(prisma, options.documents);
    const line = (item: PlannedQuote) =>
      `  ${item.documentNumber}  ${item.customerName}  entered ${item.orderDate ?? '?'}  ` +
      `delivery ${item.deliveryDate ?? 'none'}  ${item.lineCount} line(s)  ${item.isPickup ? 'pickup' : 'delivery'}\n` +
      `      Order Report ranges uploaded with it: ${describeCoverage(item.coverage)}`;

    console.log(`\nQuotation candidates: ${flag.length}`);
    for (const item of flag) {
      console.log(`${line(item)}\n      flags before: [${item.before.join(', ')}]  after: [${item.after.join(', ')}]`);
    }
    if (notJudged.length > 0) {
      console.log(
        `\nLeft alone, entered outside every Order Report range they were uploaded with ` +
          `(an open order looks the same): ${notJudged.length}`
      );
      for (const item of notJudged) console.log(line(item));
    }

    if (!options.apply) {
      console.log(flag.length > 0 ? `\nDry run. Nothing was changed.\n${UNDO}` : '\nDry run. Nothing to flag.');
      return 0;
    }

    const { written, skipped } = await applyQuoteFlags(prisma, flag);
    console.log(`\nFlagged ${written} document(s) QUOTE.`);
    if (skipped.length > 0) {
      console.log(`Skipped, because their flags changed since they were read: ${skipped.join(', ')}. Run again.`);
    }
    if (written > 0) console.log(UNDO);
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
