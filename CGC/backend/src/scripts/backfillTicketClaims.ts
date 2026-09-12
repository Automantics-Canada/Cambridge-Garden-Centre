/**
 * Claims the loads that invoices already paid for, before claims existed.
 *
 * `TicketClaim` stops one delivery paying two invoice lines, but it only knows
 * about loads spent *since* it shipped. Every invoice verified before that has
 * no claim, so its tickets still look available — and a new invoice billing the
 * same PO would be told the load is free and matched cleanly. The protection has
 * a hole exactly the shape of the client's existing data, which is most of it.
 *
 * This closes that hole by reading what the old system recorded: the tickets
 * attached to lines on invoices that reached VERIFIED or PAID.
 *
 *   Dry run (default, writes nothing):
 *     npm run backfill:ticket-claims
 *   Apply:
 *     npm run backfill:ticket-claims -- --apply
 *
 * Two things it will not do.
 *
 * It will not invent who spent a load. A claim names a person, and that name is
 * what a later reader will hold responsible, so it uses the person who actually
 * verified the invoice (`verifiedById`). A verified invoice with no verifier is
 * reported, not attributed to somebody convenient.
 *
 * It will not resolve a contested load. When two verified lines both hold the
 * same ticket, one of them was probably paid in error — that is the very failure
 * this feature exists to prevent, already in the data. Guessing a winner would
 * bury it, so the run claims neither and prints them under CONTESTED for a
 * person to settle. Those are worth real money and should be read first.
 *
 * Safety properties:
 *   - Dry run is the default; --apply is required to write anything.
 *   - Skips tickets that already have a claim, so it resumes naturally and is
 *     safe to re-run after an interrupted pass.
 *   - `claimedAt` is the invoice's verification time, not now, so the audit trail
 *     does not claim these decisions were made today.
 *   - Each claim is written on its own. One failure is reported and the run
 *     continues rather than losing a whole pass.
 *   - Nothing is deleted, and no invoice, ticket or verdict is modified.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prisma } from '../db/prisma.js';

/** Statuses that mean somebody accepted this invoice and the loads are spent. */
const SETTLED = ['VERIFIED', 'PAID'] as const;

interface Options {
  apply: boolean;
}

function parseOptions(argv: string[]): Options {
  return { apply: argv.includes('--apply') };
}

interface Holder {
  lineId: string;
  lineNumber: number;
  invoiceId: string;
  invoiceNumber: string;
  verifiedById: string | null;
  verifiedAt: Date | null;
  status: string;
}

export interface BackfillReport {
  claimable: Array<{ ticketId: string; ticketNumber: string | null; holder: Holder }>;
  contested: Array<{ ticketId: string; ticketNumber: string | null; holders: Holder[] }>;
  unattributed: Array<{ ticketId: string; ticketNumber: string | null; holder: Holder }>;
  alreadyClaimed: number;
}

/**
 * Works out what should be claimed, without writing anything.
 *
 * Separated from the writing so the decision can be tested, and so a dry run is
 * the same code path as a real one rather than an approximation of it.
 */
export async function planBackfill(): Promise<BackfillReport> {
  const lines = await prisma.invoiceLineItem.findMany({
    where: { invoice: { status: { in: [...SETTLED] } } },
    select: {
      id: true,
      lineNumber: true,
      invoice: {
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          verifiedById: true,
          verifiedAt: true,
        },
      },
      matchedTickets: { select: { id: true, ticketNumber: true } },
    },
  });

  const existing = await prisma.ticketClaim.findMany({ select: { ticketId: true } });
  const claimed = new Set(existing.map((claim) => claim.ticketId));

  // Which settled lines hold each load. More than one is the interesting case.
  const holdersByTicket = new Map<
    string,
    { ticketNumber: string | null; holders: Holder[] }
  >();

  for (const line of lines) {
    for (const ticket of line.matchedTickets) {
      if (claimed.has(ticket.id)) continue;
      const entry = holdersByTicket.get(ticket.id) ?? {
        ticketNumber: ticket.ticketNumber,
        holders: [],
      };
      entry.holders.push({
        lineId: line.id,
        lineNumber: line.lineNumber,
        invoiceId: line.invoice.id,
        invoiceNumber: line.invoice.invoiceNumber,
        verifiedById: line.invoice.verifiedById,
        verifiedAt: line.invoice.verifiedAt,
        status: line.invoice.status,
      });
      holdersByTicket.set(ticket.id, entry);
    }
  }

  const report: BackfillReport = {
    claimable: [],
    contested: [],
    unattributed: [],
    alreadyClaimed: claimed.size,
  };

  for (const [ticketId, { ticketNumber, holders }] of holdersByTicket) {
    if (holders.length > 1) {
      report.contested.push({ ticketId, ticketNumber, holders });
      continue;
    }
    const holder = holders[0]!;
    if (!holder.verifiedById) {
      report.unattributed.push({ ticketId, ticketNumber, holder });
      continue;
    }
    report.claimable.push({ ticketId, ticketNumber, holder });
  }

  return report;
}

/**
 * Writes the claims a plan found, one at a time.
 *
 * Deliberately not one transaction. These are independent historical facts, and
 * one unexpected row — a load claimed by a verification happening while this runs
 * — must not throw away every other claim in the pass. The unique constraint is
 * what makes that safe: a loser is reported, never silently duplicated.
 */
export async function applyBackfill(
  report: BackfillReport
): Promise<{ written: number; failures: Array<{ ticketId: string; detail: string }> }> {
  let written = 0;
  const failures: Array<{ ticketId: string; detail: string }> = [];

  for (const item of report.claimable) {
    try {
      await prisma.ticketClaim.create({
        data: {
          ticketId: item.ticketId,
          invoiceLineId: item.holder.lineId,
          claimedById: item.holder.verifiedById!,
          // The moment the money was actually committed, not the moment this ran.
          ...(item.holder.verifiedAt ? { claimedAt: item.holder.verifiedAt } : {}),
        },
      });
      written += 1;
    } catch (error) {
      failures.push({
        ticketId: item.ticketId,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { written, failures };
}

function describe(holder: Holder): string {
  return `${holder.invoiceNumber} line ${holder.lineNumber} (${holder.status})`;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  console.log(`Backfilling ticket claims${options.apply ? '' : ' (dry run)'}\n`);

  const report = await planBackfill();

  console.log(`  already claimed:  ${report.alreadyClaimed}`);
  console.log(`  claimable:        ${report.claimable.length}`);
  console.log(`  contested:        ${report.contested.length}`);
  console.log(`  unattributed:     ${report.unattributed.length}\n`);

  if (report.contested.length > 0) {
    console.log('CONTESTED — one load, two settled invoice lines. Read these first:');
    for (const item of report.contested) {
      const label = item.ticketNumber ?? item.ticketId;
      console.log(`  ticket ${label}`);
      for (const holder of item.holders) {
        console.log(`      ${describe(holder)}`);
      }
    }
    console.log(
      '\n  Neither line was claimed. Each of these is a load billed on two settled\n' +
        '  invoices, so one may have been paid twice. Settle them by hand, then\n' +
        '  re-run this to claim the survivors.\n'
    );
  }

  if (report.unattributed.length > 0) {
    console.log('UNATTRIBUTED — settled invoice with no recorded verifier:');
    for (const item of report.unattributed) {
      console.log(`  ticket ${item.ticketNumber ?? item.ticketId}  ${describe(item.holder)}`);
    }
    console.log('\n  Not claimed: a claim has to name who spent the load.\n');
  }

  if (!options.apply) {
    console.log(
      report.claimable.length > 0
        ? `Dry run. Re-run with --apply to write ${report.claimable.length} claim(s).`
        : 'Dry run. Nothing to claim.'
    );
    return;
  }

  const { written, failures } = await applyBackfill(report);

  console.log(`\nWrote ${written} claim(s).`);

  if (failures.length > 0) {
    console.log('\nFailed (safe to re-run; these remain unclaimed):');
    for (const failure of failures) {
      console.log(`  ${failure.ticketId}  ${failure.detail}`);
    }
    process.exitCode = 1;
  }
}

const invokedAsScript = Boolean(
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
);

if (invokedAsScript) {
  main()
    .catch((error) => {
      console.error('Backfill failed:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
