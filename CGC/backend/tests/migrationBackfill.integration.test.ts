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

  it('removes durable public URLs while preserving the bucket and object path', async () => {
    const supplier = await prisma.supplier.create({
      data: { name: 'Private Storage Migration Supplier', type: 'SUPPLIER', emailDomains: [], keywords: [] },
    });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `PRIVATE-MIGRATION-${Date.now()}`,
        senderType: 'SUPPLIER',
        supplierId: supplier.id,
        invoiceDate: new Date('2026-08-23T00:00:00Z'),
        totalAmount: null,
        currency: 'CAD',
        fileUrl: 'https://qa.supabase.co/storage/v1/object/public/test-bucket/invoices/a/file.pdf?download=1',
        emailFrom: 'private-migration@example.test',
        emailSubject: 'Sanitized private storage migration fixture',
        gmailMessageId: `private-migration-${Date.now()}`,
      },
    });
    const ticket = await prisma.ticket.create({
      data: {
        source: 'MANUAL',
        imageUrl: 'https://qa.supabase.co/storage/v1/object/public/test-bucket/tickets/a/original.jpg',
        thumbnailUrl: 'https://qa.supabase.co/storage/v1/object/public/test-bucket/ticket-thumbnails/a/thumb.webp?x=1',
        ocrRawText: '',
        ocrConfidence: 1,
        status: 'UNLINKED',
      },
    });
    const delivery = await prisma.delivery.findFirstOrThrow();
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: {
        pickupPhotoUrl: 'https://qa.supabase.co/storage/v1/object/public/test-bucket/deliveries/a/pickup.jpg',
        deliveryPhotoUrl: 'https://qa.supabase.co/storage/v1/object/public/test-bucket/deliveries/a/drop.jpg',
      },
    });

    try {
      const migration = await readFile(
        path.resolve('prisma/migrations/20260823150000_private_storage_references/migration.sql'),
        'utf8',
      );
      for (const statement of migration.split(';').map(part => part.trim()).filter(Boolean)) {
        await prisma.$executeRawUnsafe(statement);
      }

      const [storedInvoice, storedTicket, storedDelivery] = await Promise.all([
        prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }),
        prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } }),
        prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } }),
      ]);
      assert.equal(storedInvoice.fileUrl, 'storage://test-bucket/invoices/a/file.pdf');
      assert.equal(storedTicket.imageUrl, 'storage://test-bucket/tickets/a/original.jpg');
      assert.equal(storedTicket.thumbnailUrl, 'storage://test-bucket/ticket-thumbnails/a/thumb.webp');
      assert.equal(storedDelivery.pickupPhotoUrl, 'storage://test-bucket/deliveries/a/pickup.jpg');
      assert.equal(storedDelivery.deliveryPhotoUrl, 'storage://test-bucket/deliveries/a/drop.jpg');
    } finally {
      await prisma.delivery.update({
        where: { id: delivery.id },
        data: { pickupPhotoUrl: null, deliveryPhotoUrl: null },
      });
      await prisma.ticket.delete({ where: { id: ticket.id } });
      await prisma.invoice.delete({ where: { id: invoice.id } });
      await prisma.supplier.delete({ where: { id: supplier.id } });
    }
  });
});
