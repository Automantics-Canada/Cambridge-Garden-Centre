import bcrypt from 'bcryptjs';
import { prisma } from '../db/prisma.js';
import {
  InvoiceStatus,
  LineItemFlag,
  SenderType,
  SupplierType,
  UserRole,
} from '@prisma/client';

/**
 * Seeds a throwaway database with just enough to open the invoice detail screen.
 *
 * Everything here is invented. This exists to look at the "Approved amount"
 * panel in a browser, in both of its states, without touching production or any
 * real supplier's paperwork.
 *
 * Refuses to run against anything but a loopback database, because the writes
 * below are unconditional.
 */

function assertDisposable(): void {
  const url = new URL(process.env.DATABASE_URL ?? '');
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (!loopback) {
    throw new Error(`Refusing to seed a non-loopback database: ${url.hostname}`);
  }
}

async function main(): Promise<void> {
  assertDisposable();

  // Re-runnable: the script is for looking at a screen, so it starts from a
  // known state rather than accumulating duplicates across runs.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "MatchResult", "InvoiceLineItem", "Invoice", "Ticket", "Order", ' +
      '"NegotiatedRate", "Supplier", "User" RESTART IDENTITY CASCADE'
  );

  const supplier = await prisma.supplier.create({
    data: {
      name: 'Millbrook Aggregates Ltd.',
      type: SupplierType.SUPPLIER,
      emailDomains: ['millbrook.example'],
    },
  });

  await prisma.user.create({
    data: {
      name: 'UI Check',
      email: 'uicheck@example.invalid',
      passwordHash: await bcrypt.hash('local-only-password', 10),
      role: UserRole.AP_USER,
    },
  });

  // Case A — the bug. One line has an agreed rate, one does not. Before the fix
  // the missing rate fell back to the supplier's billed rate, so this invoice
  // showed an approved amount of its own total and a discrepancy of zero.
  const mixed = await prisma.invoice.create({
    data: {
      invoiceNumber: 'INV-5512',
      supplierId: supplier.id,
      senderType: SenderType.SUPPLIER,
      emailFrom: 'ap@millbrook.example',
      emailSubject: 'Invoice INV-5512',
      gmailMessageId: 'local-seed-5512',
      fileUrl: '/uploads/none.pdf',
      invoiceDate: new Date('2026-09-01'),
      receivedAt: new Date('2026-09-02'),
      totalAmount: 1120.34,
      currency: 'CAD',
      status: InvoiceStatus.PENDING_REVIEW,
      ocrRawText: '',
    },
  });

  await prisma.invoiceLineItem.createMany({
    data: [
      {
        invoiceId: mixed.id,
        lineNumber: 1,
        description: 'A Gravel 19mm',
        poNumber: '482913',
        quantity: 24.6,
        unit: 'tonnes',
        unitRate: 18.75,
        lineTotal: 461.25,
        negotiatedRate: 18.0,
        flag: LineItemFlag.RATE_MISMATCH,
      },
      {
        // No agreed rate on file. This is the line that used to be filled in
        // with the supplier's own number.
        invoiceId: mixed.id,
        lineNumber: 2,
        description: 'Delivery charge - Cambridge',
        poNumber: '482913',
        quantity: 1,
        unit: 'each',
        unitRate: 145.0,
        lineTotal: 145.0,
        negotiatedRate: null,
        flag: LineItemFlag.RATE_UNKNOWN,
      },
    ],
  });

  // Case B — every line priced, so an approved amount can honestly be stated.
  const priced = await prisma.invoice.create({
    data: {
      invoiceNumber: 'INV-5513',
      supplierId: supplier.id,
      senderType: SenderType.SUPPLIER,
      emailFrom: 'ap@millbrook.example',
      emailSubject: 'Invoice INV-5513',
      gmailMessageId: 'local-seed-5513',
      fileUrl: '/uploads/none.pdf',
      invoiceDate: new Date('2026-09-03'),
      receivedAt: new Date('2026-09-03'),
      totalAmount: 250.0,
      currency: 'CAD',
      status: InvoiceStatus.PENDING_REVIEW,
      ocrRawText: '',
    },
  });

  await prisma.invoiceLineItem.create({
    data: {
      invoiceId: priced.id,
      lineNumber: 1,
      description: 'Screened Sand',
      poNumber: '482914',
      quantity: 10,
      unit: 'tonnes',
      unitRate: 21.4,
      lineTotal: 214.0,
      // 10 x 18 = 180, +13% HST = 203.40. Supplier billed 250, so the screen
      // should show a real discrepancy of 46.60 rather than a reassuring zero.
      negotiatedRate: 18.0,
      flag: LineItemFlag.RATE_MISMATCH,
    },
  });

  // An order and a ticket for PO 482913, plus an agreed rate, so the matching
  // engine has something real to decide against. The invoice above bills
  // 18.75 where 18.00 was agreed, and the ticket is 1.6 tonnes short — two
  // discrepancies a person should see on the desk rather than discover later.
  const user = await prisma.user.findFirstOrThrow({ select: { id: true } });

  await prisma.order.create({
    data: {
      spruceOrderId: 'SEED-DOC-1',
      poNumber: '482913',
      customerName: 'A Contractor',
      product: 'A Gravel 19mm',
      quantity: 24.6,
      unit: 'tonnes',
      supplierId: supplier.id,
      orderDate: new Date('2026-09-01'),
    },
  });

  await prisma.negotiatedRate.create({
    data: {
      supplierId: supplier.id,
      productName: 'A Gravel 19mm',
      rate: 18,
      unit: 'tonnes',
      effectiveFrom: new Date('2026-01-01'),
      createdById: user.id,
    },
  });

  await prisma.ticket.create({
    data: {
      source: 'MANUAL',
      supplierId: supplier.id,
      poNumber: '482913',
      material: 'A Gravel 19mm',
      quantity: 23,
      unit: 'tonnes',
      ticketDate: new Date('2026-09-01'),
      imageUrl: '/uploads/none.png',
      ocrRawText: '',
      ocrConfidence: 0.95,
      status: 'UNLINKED',
    },
  });

  const { matchInvoiceById } = await import('../modules/matching/matching.service.js');
  await matchInvoiceById(mixed.id);
  await matchInvoiceById(priced.id);

  console.log('mixed  (no agreed rate on line 2):', mixed.id);
  console.log('priced (every line has a rate)   :', priced.id);
}

main()
  .catch((error) => {
    console.error('[seedUiCheck]', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
