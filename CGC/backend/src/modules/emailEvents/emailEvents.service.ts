import { EmailIngestionStatus, SupplierType, type Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { domainOf, invalidateKnownSenders, isFreeMailDomain } from '../../services/knownSenders.js';
import { UNIDENTIFIED_SUPPLIER_NAME } from '../invoices/invoice.service.js';

/**
 * The email review queue on the Invoices page.
 *
 * The inbox poller (services/gmail.service.ts) writes one EmailIngestionEvent
 * per email. An email from a sender no supplier record knows, or one carrying
 * nothing the app can read, is left as NEEDS_REVIEW, with no invoice made and
 * the review label on it in Gmail. From here the office:
 *
 *   approves the sender: their address (or their company's domain) is added
 *   to a supplier, new or existing, and every queued email from that sender
 *   is marked for the poller to read again on its next run;
 *
 *   ignores an email: it is not an invoice to read, and it stays out of the
 *   queue and out of the poll.
 *
 * Approving edits a supplier and decides whose invoices are read
 * automatically, so it and ignoring are OWNER/ADMIN only (decisions G5);
 * AP_USER may look.
 */

/** Why an email waits, as the poller records it. */
export const SENDER_REASONS = ['UNKNOWN_SENDER', 'UNRESOLVED_SENDER'] as const;

const QUEUE_LIMIT = 100;

const EVENT_SELECT = {
  id: true,
  status: true,
  reviewReason: true,
  subject: true,
  fromAddress: true,
  originalFrom: true,
  forwardedBy: true,
  senderMode: true,
  receivedAt: true,
  attachments: true,
  createdInvoiceIds: true,
  note: true,
  requeuedAt: true,
  reviewedAt: true,
  reviewedBy: { select: { id: true, name: true } },
  supplier: { select: { id: true, name: true } },
} as const satisfies Prisma.EmailIngestionEventSelect;

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export type ApproveMatch = 'address' | 'domain';

export interface ApproveInput {
  /** An existing supplier, or */
  supplierId?: unknown;
  /** a new one to create. */
  newSupplier?: { name?: unknown; type?: unknown } | null;
  /** Approve this exact address (the default), or everyone at its domain. */
  match?: unknown;
}

export interface ApproveResult {
  supplier: { id: string; name: string; type: SupplierType };
  added: { kind: ApproveMatch; value: string; alreadyListed: boolean };
  /** Emails from this sender now waiting for the poller to read them. */
  requeued: number;
}

export const EmailEventService = {
  /** The queue (NEEDS_REVIEW, newest first) or the ignored list. */
  async list(status: EmailIngestionStatus = EmailIngestionStatus.NEEDS_REVIEW) {
    const [events, grouped] = await Promise.all([
      prisma.emailIngestionEvent.findMany({
        where: { status },
        orderBy: { receivedAt: 'desc' },
        take: QUEUE_LIMIT,
        select: EVENT_SELECT,
      }),
      prisma.emailIngestionEvent.groupBy({
        by: ['status'],
        where: { status: { in: [EmailIngestionStatus.NEEDS_REVIEW, EmailIngestionStatus.IGNORED] } },
        _count: { _all: true },
      }),
    ]);
    const counts = { NEEDS_REVIEW: 0, IGNORED: 0 };
    for (const row of grouped) counts[row.status as keyof typeof counts] = row._count._all;
    return { events, counts, limit: QUEUE_LIMIT };
  },

  /**
   * Adds the email's original sender to a supplier and re-queues every
   * waiting email from it.
   *
   * Refused when the sender is not known (a forward whose original sender
   * could not be read has nothing to approve), when the email no longer waits
   * on its sender, or when everyone at a free-mail domain would be approved.
   */
  async approveSender(eventId: string, input: ApproveInput, userId: string): Promise<ApproveResult> {
    const match: ApproveMatch = input.match === 'domain' ? 'domain' : 'address';
    if (input.match !== undefined && input.match !== 'domain' && input.match !== 'address') {
      throw httpError(400, 'match must be "address" or "domain"');
    }

    return prisma.$transaction(async (tx) => {
      const event = await tx.emailIngestionEvent.findUnique({ where: { id: eventId } });
      if (!event) throw httpError(404, 'Email not found');
      if (event.status !== EmailIngestionStatus.NEEDS_REVIEW) {
        throw httpError(409, 'This email is no longer waiting for review.');
      }
      if (event.requeuedAt) {
        throw httpError(409, 'This sender was already approved. The email will be read on the next check.');
      }
      if (event.reviewReason !== 'UNKNOWN_SENDER' || !event.originalFrom) {
        throw httpError(409, event.reviewReason === 'UNRESOLVED_SENDER'
          ? 'The original sender could not be read from this forwarded email, so there is no sender to approve. Upload the invoice by hand, or ignore it.'
          : 'This email is waiting for its attachments, not its sender.');
      }

      const address = event.originalFrom.toLowerCase();
      const domain = domainOf(address);
      if (match === 'domain' && isFreeMailDomain(domain)) {
        throw httpError(400, `${domain} is shared by many senders. Approve the address ${address} instead.`);
      }

      const supplier = await resolveSupplier(tx, input);
      const value = match === 'domain' ? domain : address;
      const list = match === 'domain' ? supplier.emailDomains : supplier.emailAddresses;
      const alreadyListed = list.map(e => e.toLowerCase()).includes(value);
      if (!alreadyListed) {
        await tx.supplier.update({
          where: { id: supplier.id },
          data: match === 'domain'
            ? { emailDomains: { push: value } }
            : { emailAddresses: { push: value } },
        });
      }

      const now = new Date();
      const requeued = await tx.emailIngestionEvent.updateMany({
        where: {
          status: EmailIngestionStatus.NEEDS_REVIEW,
          reviewReason: 'UNKNOWN_SENDER',
          requeuedAt: null,
          originalFrom: match === 'domain'
            ? { endsWith: `@${domain}`, mode: 'insensitive' }
            : { equals: address, mode: 'insensitive' },
        },
        data: { requeuedAt: now, reviewedById: userId, reviewedAt: now, supplierId: supplier.id },
      });

      return {
        supplier: { id: supplier.id, name: supplier.name, type: supplier.type },
        added: { kind: match, value, alreadyListed },
        requeued: requeued.count,
      };
    }).finally(() => {
      // Even a refused approval is cheap to forget; a saved one must be seen
      // by this process's next lookup at once.
      invalidateKnownSenders();
    });
  },

  /** Marks a waiting email as not one to read. */
  async ignore(eventId: string, userId: string) {
    const now = new Date();
    const updated = await prisma.emailIngestionEvent.updateMany({
      where: { id: eventId, status: EmailIngestionStatus.NEEDS_REVIEW },
      data: { status: EmailIngestionStatus.IGNORED, requeuedAt: null, reviewedById: userId, reviewedAt: now },
    });
    if (updated.count === 0) {
      const exists = await prisma.emailIngestionEvent.findUnique({ where: { id: eventId }, select: { id: true } });
      throw exists
        ? httpError(409, 'This email is no longer waiting for review.')
        : httpError(404, 'Email not found');
    }
    return prisma.emailIngestionEvent.findUniqueOrThrow({ where: { id: eventId }, select: EVENT_SELECT });
  },
};

/** The supplier chosen, or the new one created, for an approval. */
async function resolveSupplier(tx: Prisma.TransactionClient, input: ApproveInput) {
  const select = { id: true, name: true, type: true, active: true, emailDomains: true, emailAddresses: true } as const;

  if (input.supplierId !== undefined && input.supplierId !== null && input.supplierId !== '') {
    if (!isUuid(input.supplierId)) throw httpError(400, 'supplierId must be a supplier id');
    const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId }, select });
    if (!supplier || !supplier.active) throw httpError(404, 'Supplier not found');
    // The holding record for invoices OCR has not attributed yet. A sender
    // filed under it would have every invoice read as nobody's, for good.
    if (supplier.name.trim().toLowerCase() === UNIDENTIFIED_SUPPLIER_NAME.toLowerCase()) {
      throw httpError(400, 'Choose the real supplier, or create one. "Unidentified supplier" is only a placeholder.');
    }
    return supplier;
  }

  const name = typeof input.newSupplier?.name === 'string' ? input.newSupplier.name.trim() : '';
  if (!name) throw httpError(400, 'Choose a supplier, or give the new supplier a name');
  const type = input.newSupplier?.type ?? SupplierType.SUPPLIER;
  if (!Object.values(SupplierType).includes(type as SupplierType)) {
    throw httpError(400, `Invalid supplier type: ${String(type)}`);
  }
  if (name.toLowerCase() === UNIDENTIFIED_SUPPLIER_NAME.toLowerCase()) {
    throw httpError(400, 'Give the new supplier its real name.');
  }
  const clash = await tx.supplier.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, active: true },
    select: { id: true },
  });
  if (clash) throw httpError(409, `A supplier named "${name}" already exists. Choose it from the list.`);

  return tx.supplier.create({
    data: { name: name.slice(0, 200), type: type as SupplierType, emailDomains: [], emailAddresses: [], keywords: [] },
    select,
  });
}
