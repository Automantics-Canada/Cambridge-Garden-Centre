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

type BackfillBuyerType = 'RETAIL' | 'CONTRACTOR';

interface BackfillOrder {
  id: string;
  spruceOrderId: string;
  customerName: string;
  poNumber: string | null;
  buyerType: BackfillBuyerType | null;
  orderDate: Date;
  deliveryDate: Date | null;
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

  // Production contains a small legacy tail where buyerType is NULL even
  // though the Prisma model is non-nullable. A normal findMany tries to decode
  // that value as the enum and aborts the entire dry run. Cast it to text so we
  // can preserve the unknown value and skip only documents that cannot be
  // classified from any of their own lines.
  const orders = await prisma.$queryRaw<BackfillOrder[]>`
    SELECT "id",
           "spruceOrderId",
           "customerName",
           "poNumber",
           "buyerType"::text AS "buyerType",
           "orderDate",
           "deliveryDate"
      FROM "public"."Order"
     WHERE "documentId" IS NULL
     ORDER BY "orderDate" ASC, "createdAt" ASC, "spruceOrderId" ASC
     LIMIT ${limit}
  `;

  console.log(`Found ${orders.length} order line(s) with no document.`);

  // Group by the document number recovered from the key.
  const groups = new Map<string, BackfillOrder[]>();
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
  let unknownBuyerDocuments = 0;
  let unknownBuyerLines = 0;
  const failures: Array<{ documentNumber: string; error: string }> = [];

  for (const [documentNumber, lines] of groups) {
    const first = lines[0]!;
    const buyerTypes = [...new Set(
      lines
        .map(line => line.buyerType)
        .filter((value): value is BackfillBuyerType => value !== null)
    )];

    // One document may contain several line rows. If at least one line carries
    // a buyer type and every known line agrees, that is the document's own
    // evidence. With no known value (or conflicting values), leave the whole
    // document unattached for explicit review rather than defaulting it.
    if (buyerTypes.length !== 1) {
      unknownBuyerDocuments++;
      unknownBuyerLines += lines.length;
      console.warn(
        `${apply ? '[skip]' : '[dry run skip]'} ${documentNumber}: ` +
        `${lines.length} line(s) have ${buyerTypes.length === 0 ? 'no buyer type' : 'conflicting buyer types'}.`
      );
      continue;
    }

    const buyerType = buyerTypes[0]!;

    if (!apply) {
      console.log(
        `[dry run] ${documentNumber}: would attach ${lines.length} line(s) ` +
        `(customer "${first.customerName}", buyer type ${buyerType}, ` +
        `ordered ${first.orderDate.toISOString().slice(0, 10)})`
      );
      continue;
    }

    try {
      const result = await prisma.$transaction(async tx => {
        const existing = await tx.orderDocument.findUnique({
          where: { documentNumber },
          select: { id: true },
        });

        const document = existing ?? await tx.orderDocument.create({
          data: {
            documentNumber,
            customerName: first.customerName,
            poNumber: first.poNumber,
            buyerType,
            orderDate: first.orderDate,
            deliveryDate: first.deliveryDate,
          },
          select: { id: true },
        });

        // lineNumber is assigned by the order the lines were selected in, which
        // is deterministic, so re-running produces the same numbering.
        for (let i = 0; i < lines.length; i++) {
          await tx.order.update({
            where: { id: lines[i]!.id },
            data: { documentId: document.id, lineNumber: i + 1 },
          });
        }

        return {
          created: existing ? 0 : 1,
          reused: existing ? 1 : 0,
          attached: lines.length,
        };
      }, {
        // Prisma's interactive-transaction default is five seconds. Larger
        // documents legitimately contain dozens of line rows and exceeded it
        // over the production pooler even though the database stayed healthy.
        maxWait: 10_000,
        timeout: 120_000,
      });

      created += result.created;
      reused += result.reused;
      attached += result.attached;
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
    console.log(
      `Would create up to ${groups.size - unknownBuyerDocuments} document(s) and attach ` +
      `${orders.length - unparseable.length - unknownBuyerLines} line(s).`
    );
  }
  console.log(`Skipped (unparseable key): ${unparseable.length}`);
  console.log(
    `Skipped (buyer type unknown/conflicting): ${unknownBuyerDocuments} document(s), ` +
    `${unknownBuyerLines} line(s)`
  );

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
