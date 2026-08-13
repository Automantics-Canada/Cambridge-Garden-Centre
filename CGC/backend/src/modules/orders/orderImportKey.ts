/**
 * Synthesises the unique `Order.spruceOrderId` for one parsed PDF import row.
 *
 * A Spruce document number is not unique per row: one document spans many line
 * items, and the parser carries the last seen document number forward across
 * blank cells. The stored key therefore has to combine the document number with
 * the row's position in the source PDF.
 *
 * Textract restarts `RowIndex` at 1 for every TABLE block, so page alone is not
 * enough — two tables on the same page both produce a row 2. The key must be
 * unique across document, page, table and row.
 *
 * The page and table components are omitted when they are the first of their
 * kind. That keeps keys for page 1 / table 1 byte-identical to the format used
 * before multi-page support existed, so re-importing a single-table document
 * still updates the existing Order rather than creating a duplicate.
 *
 * The function is pure and total: the same source row always yields the same
 * key, which is what makes re-import idempotent.
 */
export interface SpruceOrderKeyParts {
  /** Document/order number read from the row, or carried forward. */
  documentId: string;
  /** Zero-based page index within the uploaded PDF. */
  pageIndex: number;
  /** Zero-based TABLE block index within that page. */
  tableIndex: number;
  /** Textract row index, one-based within its own table. */
  rowIndex: number;
}

export function buildSpruceOrderKey({
  documentId,
  pageIndex,
  tableIndex,
  rowIndex,
}: SpruceOrderKeyParts): string {
  const pageSuffix = pageIndex === 0 ? '' : `-P${pageIndex + 1}`;
  const tableSuffix = tableIndex === 0 ? '' : `-T${tableIndex + 1}`;
  return `${documentId}${pageSuffix}${tableSuffix}-${rowIndex}`;
}
