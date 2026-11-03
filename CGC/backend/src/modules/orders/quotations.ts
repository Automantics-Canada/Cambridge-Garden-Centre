import type { PrismaClient } from '@prisma/client';

/**
 * Quotations in Spruce: prices given to customers, never orders. The import
 * flags one QUOTE; see `batchFlags`. Nothing is delivered against a quotation
 * and nothing is billed for one, so a ticket or an invoice that seems to
 * belong to one belongs to the order it later became, or to another order.
 */

/** The flag the import sets on a quotation. */
export const QUOTE_FLAG = 'QUOTE';

/**
 * The office's "Not a quotation": the import took a real order for one, and
 * no later upload may again. See `markNotQuotation`.
 */
export const NOT_A_QUOTE_FLAG = 'NOT_A_QUOTE';

/** What a refusal adds, so the person refused knows the way out. */
export const NOT_A_QUOTATION_HINT = 'If it is a real order, mark it "Not a quotation" on the order first.';

type LineReader = Pick<PrismaClient, 'order'>;

/**
 * Refuses, with a 409 the caller can show as it is, to link something to a
 * line of a quotation. A line from before orders were grouped has no order,
 * so it is never refused.
 *
 * @param what what was being linked, for the message: "a ticket"
 */
export async function refuseQuotationLine(db: LineReader, orderId: string, what: string): Promise<void> {
  const line = await db.order.findUnique({
    where: { id: orderId },
    select: { document: { select: { documentNumber: true, flags: true } } },
  });
  const document = line?.document;
  if (document?.flags.includes(QUOTE_FLAG)) {
    throw Object.assign(
      new Error(
        `${document.documentNumber} is a quotation in Spruce, not an order, so ${what} cannot be linked to it. ${NOT_A_QUOTATION_HINT}`
      ),
      { status: 409 }
    );
  }
}
