import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const UPLOAD_ROOT = path.join(process.cwd(), 'uploads');
const TICKET_DIR = path.join(UPLOAD_ROOT, 'tickets');
const INVOICE_DIR = path.join(UPLOAD_ROOT, 'invoices');

async function ensureTicketDir() {
  await fs.mkdir(TICKET_DIR, { recursive: true });
}

async function ensureInvoiceDir() {
  await fs.mkdir(INVOICE_DIR, { recursive: true });
}

/**
 * Save a ticket image buffer to /uploads/tickets and return its public path.
 * Later you can swap this out for R2/S3 with the same function signature.
 */
export async function saveTicketImage(
  buffer: Buffer,
  originalName: string
): Promise<string> {
  await ensureTicketDir();

  const ext = path.extname(originalName) || '.jpg';
  const fileName = `${crypto.randomUUID()}${ext}`;
  const fullPath = path.join(TICKET_DIR, fileName);

  await fs.writeFile(fullPath, buffer);

  // Served by Express as /uploads/...
  return `/uploads/tickets/${fileName}`;
}

export async function saveInvoiceImage(
  buffer: Buffer,
  originalName: string
): Promise<string> {
  await ensureInvoiceDir();

  const ext = path.extname(originalName) || '.pdf';
  const fileName = `${crypto.randomUUID()}${ext}`;
  const fullPath = path.join(INVOICE_DIR, fileName);

  await fs.writeFile(fullPath, buffer);

  return `/uploads/invoices/${fileName}`;
}