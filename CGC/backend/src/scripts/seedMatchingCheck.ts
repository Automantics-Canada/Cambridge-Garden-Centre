import { prisma } from '../db/prisma.js';
import {
  InvoiceStatus,
  LineItemFlag,
  SenderType,
  SupplierType,
  TicketSource,
  TicketStatus,
} from '@prisma/client';

/**
 * Seeds a throwaway database with the situations the matching engine exists to
 * tell apart, so they can be looked at in a browser.
 *
 * Everything here is invented — no client paperwork, no real supplier, no real
 * PO. It exists because the interesting cases are the ones a person has to
 * judge, and those are hard to trust from a unit test alone: what the ticket
 * list says next to what the verification desk says, and whether the two agree.
 *
 * Four situations, each on its own purchase order so they can be read
 * independently:
 *
 *   482913  A ticket whose PO names exactly one order, but whose wording and
 *           weight disagree with it. Must be LINKED with the discrepancy shown.
 *   550001  Two orders on one PO. Nothing can be identified, so a previously
 *           auto-linked ticket must come back off.
 *   600123  One PO carrying two products, billed as two invoice lines. Each
 *           line must count only its own loads.
 *   600123  A second invoice billing the same PO, so the contention and reuse
 *           refusals can be exercised.
 *
 * Refuses to run against anything but a loopback database, because the writes
 * below are unconditional and start by emptying tables.
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
  // known state rather than accumulating duplicates across runs. `User` is
  // deliberately absent — the bootstrapped admin has to survive a reseed, or
  // there is no way back into the browser.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "TicketClaim", "AuditLog", "MatchResult", "TicketOrderMatch", ' +
      '"InvoiceLineItem", "Invoice", "Ticket", "Order", "OrderDocument", ' +
      '"NegotiatedRate", "SupplierProductAlias", "Supplier" RESTART IDENTITY CASCADE'
  );

  const operator = await prisma.user.findFirstOrThrow({
    where: { role: 'ADMIN', active: true },
    select: { id: true },
  });

  const supplier = await prisma.supplier.create({
    data: {
      name: 'Millbrook Aggregates Ltd.',
      type: SupplierType.SUPPLIER,
      emailDomains: ['millbrook.example'],
    },
  });

  const agreedRate = (productName: string, rate: number) =>
    prisma.negotiatedRate.create({
      data: {
        supplierId: supplier.id,
        productName,
        rate,
        unit: 'tonnes',
        effectiveFrom: new Date('2026-01-01'),
        createdById: operator.id,
      },
    });

  await agreedRate('STONE 3/4 CLEAR LIMESTONE', 18);
  await agreedRate('A Gravel 19mm', 18);
  await agreedRate('Concrete Sand', 22);

  const order = (
    spruceOrderId: string,
    poNumber: string,
    product: string,
    quantity: number
  ) =>
    prisma.order.create({
      data: {
        spruceOrderId,
        poNumber,
        customerName: 'A Contractor',
        product,
        quantity,
        unit: 'tonnes',
        supplierId: supplier.id,
        orderDate: new Date('2026-09-01'),
      },
    });

  const ticket = (data: {
    ticketNumber: string;
    poNumber: string;
    material: string | null;
    quantity: number;
    supplierId?: string | null;
  }) =>
    prisma.ticket.create({
      data: {
        source: TicketSource.MANUAL,
        ticketNumber: data.ticketNumber,
        supplierId: data.supplierId === undefined ? supplier.id : data.supplierId,
        poNumber: data.poNumber,
        material: data.material,
        quantity: data.quantity,
        unit: 'tonnes',
        ticketDate: new Date('2026-09-01'),
        imageUrl: '/uploads/none.png',
        ocrRawText: '',
        ocrConfidence: 0.95,
        status: TicketStatus.UNLINKED,
      },
    });

  // --- 482913: identified by PO, disagrees on wording and weight ------------
  //
  // The ordinary case, and the one the link rule turns on. The yard writes
  // "3/4 clear"; Spruce prints "STONE 3/4 CLEAR LIMESTONE". Nobody has recorded
  // that alias yet, and the load is 1.6 tonnes light. The PO still names
  // exactly one order, so this is a linked delivery with two things to look at
  // — not an unlinked one.
  await order('SEED-DOC-1', '482913', 'STONE 3/4 CLEAR LIMESTONE', 24.6);
  const partialTicket = await ticket({
    ticketNumber: 'T-88213',
    poNumber: '482913',
    material: '3/4 clear',
    quantity: 23,
  });

  // --- 550001: two orders on one PO ----------------------------------------
  //
  // Pre-linked by the engine's predecessor, so the sweep has something to take
  // away. Equal quantities, so quantity cannot break the tie either.
  const conflictA = await order('SEED-DOC-2A', '550001', 'A Gravel 19mm', 20);
  await order('SEED-DOC-2B', '550001', 'A Gravel 19mm', 20);
  const conflictTicket = await ticket({
    ticketNumber: 'T-88301',
    poNumber: '550001',
    material: 'A Gravel 19mm',
    quantity: 20,
  });
  await prisma.ticketOrderMatch.create({
    data: { ticketId: conflictTicket.id, orderId: conflictA.id, matchMethod: 'AUTO_PO' },
  });
  await prisma.ticket.update({
    where: { id: conflictTicket.id },
    data: { linkedOrderId: conflictA.id, status: TicketStatus.LINKED, linkMethod: 'AUTO' },
  });

  // --- 600123: one PO, two products ----------------------------------------
  await order('SEED-DOC-3A', '600123', 'A Gravel 19mm', 24.6);
  await order('SEED-DOC-3B', '600123', 'Concrete Sand', 18);
  const gravelLoad = await ticket({
    ticketNumber: 'T-88401',
    poNumber: '600123',
    material: 'A Gravel 19mm',
    quantity: 24.6,
  });
  const sandLoad = await ticket({
    ticketNumber: 'T-88402',
    poNumber: '600123',
    material: 'Concrete Sand',
    quantity: 18,
  });
  // A load whose supplier OCR could not read. It belongs to neither line's
  // product either, so it should be counted by neither and mentioned by both.
  await ticket({
    ticketNumber: 'T-88403',
    poNumber: '600123',
    material: 'Screened Topsoil',
    quantity: 5,
    supplierId: null,
  });

  const invoice = async (
    invoiceNumber: string,
    totalAmount: number,
    lines: Array<{
      description: string;
      quantity: number;
      unitRate: number;
      poNumber: string;
    }>
  ) =>
    prisma.invoice.create({
      data: {
        invoiceNumber,
        supplierId: supplier.id,
        senderType: SenderType.SUPPLIER,
        emailFrom: 'ap@millbrook.example',
        emailSubject: `Invoice ${invoiceNumber}`,
        gmailMessageId: `local-seed-${invoiceNumber}`,
        fileUrl: '/uploads/none.pdf',
        invoiceDate: new Date('2026-09-02'),
        receivedAt: new Date('2026-09-02'),
        totalAmount,
        currency: 'CAD',
        status: InvoiceStatus.PENDING_REVIEW,
        ocrRawText: '',
        lineItems: {
          create: lines.map((line, index) => ({
            lineNumber: index + 1,
            description: line.description,
            poNumber: line.poNumber,
            quantity: line.quantity,
            unit: 'tonnes',
            unitRate: line.unitRate,
            lineTotal: Number((line.quantity * line.unitRate).toFixed(2)),
            // Written as unchecked. Everything else on the row is the engine's
            // to fill in, and a line nothing has looked at must not arrive
            // looking like one that passed.
            flag: LineItemFlag.MULTIPLE_FLAGS,
          })),
        },
      },
      include: { lineItems: { orderBy: { lineNumber: 'asc' } } },
    });

  const twoProduct = await invoice('INV-6001', 942.48, [
    { description: 'A Gravel 19mm', quantity: 24.6, unitRate: 18, poNumber: '600123' },
    // Billed above the agreed 22.00, so one line carries a rate discrepancy and
    // the other does not — the invoice screen and the desk have to agree about
    // which is which.
    { description: 'Concrete Sand', quantity: 18, unitRate: 24.5, poNumber: '600123' },
  ]);

  // --- A second invoice billing the same PO --------------------------------
  const repeat = await invoice('INV-6007', 442.8, [
    { description: 'A Gravel 19mm', quantity: 24.6, unitRate: 18, poNumber: '600123' },
  ]);

  // Decide everything, the way the running system would. Tickets first: a
  // line's coverage depends on which loads exist and which are already spent.
  const { matchTicketById, matchInvoiceById } = await import(
    '../modules/matching/matching.service.js'
  );

  for (const id of [partialTicket.id, conflictTicket.id, gravelLoad.id, sandLoad.id]) {
    await matchTicketById(id);
  }
  await matchInvoiceById(twoProduct.id);
  await matchInvoiceById(repeat.id);

  const linked = await prisma.ticket.findMany({
    where: { poNumber: { in: ['482913', '550001'] } },
    select: { ticketNumber: true, status: true, linkMethod: true, linkedOrderId: true },
    orderBy: { ticketNumber: 'asc' },
  });

  console.log('\nSeeded. Ticket link state:');
  for (const row of linked) {
    console.log(
      `  ${row.ticketNumber}: ${row.status} linkMethod=${row.linkMethod ?? 'null'} ` +
        `order=${row.linkedOrderId ?? 'none'}`
    );
  }
  console.log(`\n  two-product invoice INV-6001: ${twoProduct.id}`);
  console.log(`  repeat invoice     INV-6007: ${repeat.id}`);
}

main()
  .catch((error) => {
    console.error('[seedMatchingCheck]', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
