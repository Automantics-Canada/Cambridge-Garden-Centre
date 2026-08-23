import './setupEnv.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { prisma } from '../src/db/prisma.js';

const disposableConfirmed = process.env.CGC_TEST_CONFIRM_DISPOSABLE === '1';

describe('operational schema reconciliation', { skip: !disposableConfirmed }, () => {
  after(async () => {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "InvoiceLineItem" DROP COLUMN IF EXISTS "matchedTicketId"'
    );
    await prisma.$disconnect();
  });

  it('copies a legacy matched ticket into the join table before dropping the old column', async () => {
    const supplier = await prisma.supplier.create({
      data: { name: 'Migration QA Supplier', type: 'SUPPLIER', emailDomains: [], keywords: [] },
    });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: 'MIGRATION-QA-1',
        senderType: 'SUPPLIER',
        supplierId: supplier.id,
        invoiceDate: new Date('2026-08-23T00:00:00Z'),
        totalAmount: 100,
        currency: 'CAD',
        fileUrl: '/uploads/qa/migration-invoice.png',
        emailFrom: 'migration@example.test',
        emailSubject: 'Sanitized migration fixture',
        gmailMessageId: `migration-${Date.now()}`,
      },
    });
    const line = await prisma.invoiceLineItem.create({
      data: {
        invoiceId: invoice.id,
        lineNumber: 1,
        description: 'Sanitized material',
        quantity: 1,
        unit: 'tonnes',
        unitRate: 100,
        lineTotal: 100,
        flag: 'OK',
      },
    });
    const ticket = await prisma.ticket.create({
      data: {
        source: 'MANUAL',
        imageUrl: '/uploads/qa/migration-ticket.png',
        ocrRawText: '',
        ocrConfidence: 1,
        status: 'UNLINKED',
      },
    });

    await prisma.$executeRawUnsafe(
      'ALTER TABLE "InvoiceLineItem" ADD COLUMN "matchedTicketId" UUID'
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "InvoiceLineItem_matchedTicketId_fkey" ' +
      'FOREIGN KEY ("matchedTicketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE'
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "InvoiceLineItem" SET "matchedTicketId" = '${ticket.id}' WHERE "id" = '${line.id}'`
    );

    const migration = await readFile(
      path.resolve('prisma/migrations/20260823110000_reconcile_operational_schema/migration.sql'),
      'utf8'
    );
    const marker = '-- Preserve every legacy one-to-one ticket link';
    const blockStart = migration.indexOf('DO $$ BEGIN', migration.indexOf(marker));
    const blockEnd = migration.indexOf('END $$;', blockStart) + 'END $$;'.length;
    assert.ok(blockStart >= 0 && blockEnd > blockStart, 'migration backfill block is present');
    await prisma.$executeRawUnsafe(migration.slice(blockStart, blockEnd));

    const links = await prisma.$queryRaw<Array<{ A: string; B: string }>>`
      SELECT "A", "B"
      FROM "_InvoiceLineItemToTicket"
      WHERE "A" = ${line.id}::uuid AND "B" = ${ticket.id}::uuid
    `;
    assert.deepEqual(links, [{ A: line.id, B: ticket.id }]);

    const columns = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'InvoiceLineItem'
        AND column_name = 'matchedTicketId'
    `;
    assert.equal(columns[0]?.count, 0n);
  });
});
