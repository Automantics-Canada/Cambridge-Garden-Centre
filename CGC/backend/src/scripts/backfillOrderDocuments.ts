/**
 * Groups existing Order rows under the Spruce document they came from.
 *
 * Orders are stored one row per line item, keyed by a `spruceOrderId` the
 * importer synthesised from the row's position in the uploaded PDF. The
 * document number is inside that key but is not stored as a key of its own, so
 * nothing can join the delivery report to the PO report. This fills in
 * `OrderDocument` and points each `Order` at it.
 *
 *   Dry run (default, writes nothing):
 *     npm run backfill:order-documents
 *   Apply:
 *     npm run backfill:order-documents -- --apply
 *   Bound a run:
 *     npm run backfill:order-documents -- --apply --limit=500
 *
 * Safety properties:
 *   - Dry run is the default; --apply is required to write anything.
 *   - Selects only rows where documentId IS NULL, so it resumes naturally and
 *     is safe to re-run after a partial or interrupted pass.
 *   - A row whose key does not parse is skipped and reported, never guessed at.
 *   - Document fields are taken from the earliest line of each document, so a
 *     repeat run is idempotent rather than dependent on row order.
 *   - Each document and its lines are written in one transaction, so a run that
 *     dies partway leaves whole documents done and the rest untouched.
 *   - No Order is deleted, merged or renumbered. `spruceOrderId` is untouched,
 *     so every existing foreign key and screen keeps working either way.
 */
import { PrismaClient } from '@prisma/client';
import { documentNumberFromSpruceOrderKey } from '../modules/orders/orderImportKey.js';

const prisma = new PrismaClient();

const DEFAULT_LIMIT = 5000;

interface Args {
  apply: boolean;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const apply = argv.includes('--apply');
  const limitArg = argv.find(a => a.startsWith('--limit='));
  const parsed = limitArg ? Number(limitArg.split('=')[1]) : DEFAULT_LIMIT;
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : DEFAULT_LIMIT;
  return { apply, limit };
}

async function main() {
  const { apply, limit } = parseArgs(process.argv.slice(2));

  console.log(
    apply
      ? `Backfilling order documents (writing), limit ${limit}.`
      : `DRY RUN — nothing will be written. Limit ${limit}. Pass --apply to write.`
  );

  const orders = await prisma.order.findMany({
    where: { documentId: null },
    // Oldest first so a document's fields come from its earliest line on every
    // run, making repeated runs produce the same result.
    orderBy: [{ orderDate: 'asc' }, { createdAt: 'asc' }, { spruceOrderId: 'asc' }],
    take: limit,
    select: {
      id: true,
      spruceOrderId: true,
      customerName: true,
      poNumber: true,
      buyerType: true,
      orderDate: true,
      deliveryDate: true,
    },
  });

  console.log(`Found ${orders.length} order line(s) with no document.`);

  // Group by the document number recovered from the key.
  const groups = new Map<string, typeof orders>();
  const unparseable: string[] = [];

  for (const order of orders) {
    const documentNumber = documentNumberFromSpruceOrderKey(order.spruceOrderId);
    if (!documentNumber) {
      unparseable.push(order.spruceOrderId);
      continue;
    }
    const existing = groups.get(documentNumber);
    if (existing) existing.push(order);
    else groups.set(documentNumber, [order]);
  }

  console.log(`Resolved ${groups.size} document(s).`);
  if (unparseable.length > 0) {
    console.warn(
      `${unparseable.length} row(s) had a key this script cannot parse and were skipped:\n  ` +
      unparseable.slice(0, 20).join('\n  ') +
      (unparseable.length > 20 ? `\n  ...and ${unparseable.length - 20} more` : '')
    );
  }

  let created = 0;
  let attached = 0;
  let reused = 0;
  const failures: Array<{ documentNumber: string; error: string }> = [];

  for (const [documentNumber, lines] of groups) {
    const first = lines[0]!;

    if (!apply) {
      console.log(
        `[dry run] ${documentNumber}: would attach ${lines.length} line(s) ` +
        `(customer "${first.customerName}", ordered ${first.orderDate.toISOString().slice(0, 10)})`
      );
      continue;
    }

    try {
      await prisma.$transaction(async tx => {
        const existing = await tx.orderDocument.findUnique({
          where: { documentNumber },
          select: { id: true },
        });

        if (existing) reused++;

        const document = existing ?? await tx.orderDocument.create({
          data: {
            documentNumber,
            customerName: first.customerName,
            poNumber: first.poNumber,
            buyerType: first.buyerType,
            orderDate: first.orderDate,
            deliveryDate: first.deliveryDate,
          },
          select: { id: true },
        });

        if (!existing) created++;

        // lineNumber is assigned by the order the lines were selected in, which
        // is deterministic, so re-running produces the same numbering.
        for (let i = 0; i < lines.length; i++) {
          await tx.order.update({
            where: { id: lines[i]!.id },
            data: { documentId: document.id, lineNumber: i + 1 },
          });
          attached++;
        }
      });
    } catch (error: any) {
      failures.push({ documentNumber, error: error?.message || 'Unknown error' });
    }
  }

  console.log('---');
  if (apply) {
    console.log(`Documents created: ${created}`);
    console.log(`Documents already present: ${reused}`);
    console.log(`Order lines attached: ${attached}`);
  } else {
    console.log(`Would create up to ${groups.size} document(s) and attach ${orders.length - unparseable.length} line(s).`);
  }
  console.log(`Skipped (unparseable key): ${unparseable.length}`);

  if (failures.length > 0) {
    console.error(`Failed documents: ${failures.length}`);
    for (const failure of failures) {
      console.error(`  ${failure.documentNumber}: ${failure.error}`);
    }
    process.exitCode = 1;
  }

  if (orders.length === limit) {
    console.log(`Hit the limit of ${limit}; run again to continue.`);
  }
}

main()
  .catch(error => {
    console.error('Backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
