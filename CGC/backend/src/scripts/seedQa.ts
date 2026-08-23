import bcrypt from 'bcryptjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { prisma } from '../db/prisma.js';
import { assertDisposableQaDatabase } from './qaGuard.js';

const ADMIN_EMAIL = 'admin.qa@example.test';
const AP_EMAIL = 'ap.qa@example.test';
const DRIVER_EMAIL = 'driver.qa@example.test';
const ADMIN_PASSWORD = 'QA-Admin-2026!';
const AP_PASSWORD = 'QA-Ap-2026!';
const DRIVER_PASSWORD = 'QA-Driver-2026!';

async function writeFixtureImages(): Promise<void> {
  const fixtureRoot = path.resolve(process.cwd(), 'uploads', 'qa');
  await fs.mkdir(fixtureRoot, { recursive: true });
  const png = await sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background: { r: 45, g: 106, b: 79 },
    },
  }).png().toBuffer();
  await Promise.all([
    fs.writeFile(path.join(fixtureRoot, 'ticket.png'), png),
    fs.writeFile(path.join(fixtureRoot, 'invoice.png'), png),
    fs.writeFile(path.join(fixtureRoot, 'delivery.png'), png),
  ]);
}

async function main(): Promise<void> {
  assertDisposableQaDatabase();
  if (process.env.STORAGE_DRIVER !== 'local') {
    throw new Error('QA seed requires STORAGE_DRIVER=local');
  }

  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "DeliveryHistory", "Delivery", "OcrJob", "_InvoiceLineItemToTicket",
      "TicketOrderMatch", "InvoiceLineItem", "Invoice", "Ticket", "Order",
      "OrderDocument", "SupplierProductAlias", "SupplierSpruceVendor",
      "NegotiatedRate", "Product", "Unit", "EmailIngestionEvent",
      "WhatsAppMessage", "SystemSetting", "AuditLog", "SpruceImportRowError",
      "SpruceImportJob", "Driver", "Supplier", "User"
    RESTART IDENTITY CASCADE
  `);

  const [adminHash, apHash, driverHash] = await Promise.all([
    bcrypt.hash(ADMIN_PASSWORD, 10),
    bcrypt.hash(AP_PASSWORD, 10),
    bcrypt.hash(DRIVER_PASSWORD, 10),
  ]);

  const admin = await prisma.user.create({
    data: { name: 'QA Administrator', email: ADMIN_EMAIL, passwordHash: adminHash, role: 'ADMIN' },
  });
  await prisma.user.create({
    data: { name: 'QA Accounts Payable', email: AP_EMAIL, passwordHash: apHash, role: 'AP_USER' },
  });
  const driverUser = await prisma.user.create({
    data: { name: 'QA Driver', email: DRIVER_EMAIL, passwordHash: driverHash, role: 'DRIVER' },
  });
  const driver = await prisma.driver.create({
    data: {
      name: 'QA Driver',
      phone: '+15550002026',
      email: DRIVER_EMAIL,
      type: 'CGC_FLEET',
      userId: driverUser.id,
    },
  });

  const supplier = await prisma.supplier.create({
    data: {
      name: 'QA Aggregates Ltd',
      type: 'SUPPLIER',
      emailDomains: ['qa-aggregates.example.test'],
      keywords: ['qa aggregates'],
      contactName: 'QA Supplier Contact',
      contactEmail: 'billing@qa-aggregates.example.test',
    },
  });
  await prisma.unit.createMany({ data: [{ name: 'tonnes' }, { name: 'cubic yards' }] });
  await prisma.product.createMany({
    data: [
      { name: 'Granular A Gravel', unit: 'tonnes' },
      { name: 'Screened Sand', unit: 'tonnes' },
    ],
  });
  await prisma.negotiatedRate.create({
    data: {
      supplierId: supplier.id,
      productName: 'Granular A Gravel',
      rate: 18.5,
      unit: 'tonnes',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      createdById: admin.id,
    },
  });

  const document = await prisma.orderDocument.create({
    data: {
      documentNumber: 'QA-260823',
      customerName: 'QA Landscape Customer',
      poNumber: '447201',
      buyerType: 'CONTRACTOR',
      orderDate: new Date('2026-08-23T00:00:00Z'),
      deliveryDate: new Date('2026-08-24T00:00:00Z'),
      shippingAddress: '100 Test Garden Road, Cambridge, ON',
    },
  });
  const assignedOrder = await prisma.order.create({
    data: {
      spruceOrderId: 'QA-260823-L1',
      documentId: document.id,
      lineNumber: 1,
      spruceItemNumber: 'GRANULARA',
      poNumber: '447201',
      customerName: document.customerName,
      buyerType: 'CONTRACTOR',
      product: 'Granular A Gravel',
      quantity: 25,
      unit: 'tonnes',
      supplierId: supplier.id,
      orderDate: document.orderDate,
      deliveryDate: document.deliveryDate,
      driverId: driver.id,
      deliveryStatus: 'NOT_STARTED',
    },
  });
  const unassignedOrder = await prisma.order.create({
    data: {
      spruceOrderId: 'QA-260823-L2',
      documentId: document.id,
      lineNumber: 2,
      spruceItemNumber: 'SANDSCRN',
      poNumber: '447201',
      customerName: document.customerName,
      buyerType: 'CONTRACTOR',
      product: 'Screened Sand',
      quantity: 10,
      unit: 'tonnes',
      supplierId: supplier.id,
      orderDate: document.orderDate,
      deliveryDate: document.deliveryDate,
      deliveryStatus: 'NOT_STARTED',
    },
  });
  const delivery = await prisma.delivery.create({
    data: { orderId: assignedOrder.id, driverId: driver.id, status: 'PLACED', priority: 1 },
  });
  await prisma.delivery.create({
    data: { orderId: unassignedOrder.id, status: 'UNASSIGNED', priority: 2 },
  });

  const ticket = await prisma.ticket.create({
    data: {
      ticketNumber: 'QA-TICKET-1',
      source: 'MANUAL',
      supplierId: supplier.id,
      supplierName: supplier.name,
      poNumber: '447201',
      material: 'Granular A Gravel',
      quantity: 25,
      unit: 'tonnes',
      ticketDate: new Date('2026-08-23T00:00:00Z'),
      imageUrl: '/uploads/qa/ticket.png',
      thumbnailUrl: '/uploads/qa/ticket.png',
      ocrRawText: 'QA sanitized ticket fixture',
      ocrConfidence: 0.99,
      linkedOrderId: assignedOrder.id,
      status: 'LINKED',
      linkMethod: 'MANUAL',
      driverId: driver.id,
    },
  });
  await prisma.ticketOrderMatch.create({
    data: { ticketId: ticket.id, orderId: assignedOrder.id, matchMethod: 'QA_SEED', createdBy: admin.id },
  });

  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: 'QA-INV-1001',
      senderType: 'SUPPLIER',
      supplierId: supplier.id,
      invoiceDate: new Date('2026-08-23T00:00:00Z'),
      totalAmount: 522.63,
      currency: 'CAD',
      fileUrl: '/uploads/qa/invoice.png',
      emailFrom: 'billing@qa-aggregates.example.test',
      emailSubject: 'QA invoice',
      gmailMessageId: 'qa-invoice-complete-1001',
      status: 'PENDING_REVIEW',
      OcrJobStatus: 'COMPLETED',
      ocrRawText: 'QA sanitized invoice fixture',
      lineItems: {
        create: {
          lineNumber: 1,
          poNumber: '447201',
          description: 'Granular A Gravel',
          quantity: 25,
          unit: 'tonnes',
          unitRate: 18.5,
          lineTotal: 462.5,
          matchedOrderId: assignedOrder.id,
          negotiatedRate: 18.5,
          approvedTotal: 522.63,
          flag: 'OK',
          matchedTickets: { connect: { id: ticket.id } },
        },
      },
    },
  });
  await prisma.ocrJob.create({
    data: {
      type: 'INVOICE',
      provider: 'AWS_TEXTRACT',
      status: 'COMPLETED',
      invoiceId: invoice.id,
      structuredProvider: 'DETERMINISTIC',
      fallbackUsed: false,
      extractionConfidence: 0.99,
      finishedAt: new Date(),
    },
  });

  const reviewInvoice = await prisma.invoice.create({
    data: {
      invoiceNumber: 'PENDING-QA-REVIEW',
      senderType: 'SUPPLIER',
      supplierId: supplier.id,
      invoiceDate: new Date('2026-08-23T00:00:00Z'),
      totalAmount: null,
      currency: 'CAD',
      fileUrl: '/uploads/qa/invoice.png',
      emailFrom: 'review@qa-aggregates.example.test',
      emailSubject: 'QA invoice requiring review',
      gmailMessageId: 'qa-invoice-review-1002',
      status: 'PENDING_REVIEW',
      OcrJobStatus: 'NEEDS_REVIEW',
    },
  });
  await prisma.ocrJob.create({
    data: {
      type: 'INVOICE',
      provider: 'AWS_TEXTRACT',
      status: 'NEEDS_REVIEW',
      invoiceId: reviewInvoice.id,
      structuredProvider: 'DETERMINISTIC_GROQ_FALLBACK',
      structuredModel: 'openai/gpt-oss-20b',
      fallbackUsed: true,
      reviewReasons: ['total: Fallback candidate requires confirmation'],
      extractionConfidence: 0.61,
      finishedAt: new Date(),
      rawResponse: {
        fields: { total: { value: 462.5, source: 'GROQ', confidence: 0.6, state: 'VALID' } },
        autoLink: { linked: false, method: null },
      },
    },
  });

  await writeFixtureImages();
  console.log(JSON.stringify({
    database: 'cgc_integration',
    users: {
      admin: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      ap: { email: AP_EMAIL, password: AP_PASSWORD },
      driver: { email: DRIVER_EMAIL, password: DRIVER_PASSWORD },
    },
    ids: { driverId: driver.id, deliveryId: delivery.id, invoiceId: invoice.id, reviewInvoiceId: reviewInvoice.id },
  }, null, 2));
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
