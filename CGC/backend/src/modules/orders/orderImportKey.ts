/**
 * The unique `Order.spruceOrderId` for one line of a Spruce document.
 *
 * A document number is not unique per row — one document spans many lines — so
 * the key pairs it with the line's number within that document.
 *
 * This is the key the importer writes. It records where a line sits in its
 * document rather than where it sat on a page, which is what makes it stable:
 * the same line keeps the same key however the report is paginated, and a
 * re-import updates the row it wrote before instead of adding another beside
 * it. The `-L` marker distinguishes these from every earlier shape below.
 */
export function buildSpruceLineKey(documentNumber: string, lineNumber: number): string {
  return `${documentNumber}-L${lineNumber}`;
}

/**
 * Synthesises the `Order.spruceOrderId` an OCR import row would have had.
 *
 * Superseded by `buildSpruceLineKey` and kept only to read what is already
 * stored. Nothing writes this shape any more.
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

/**
 * Recovers the Spruce document number from a synthesised `spruceOrderId`.
 *
 * The key format is `<document>[-P<page>][-T<table>]-<row>`, and the text-
 * extraction fallback produced `<document>-T-<index>`. Everything after the
 * document number is a coordinate in the source PDF, so stripping those
 * suffixes leaves the number Spruce actually printed.
 *
 * Used by the backfill to group existing rows, and by the importer to adopt a
 * legacy row instead of creating a duplicate alongside it. Returns null when
 * the key does not match the known shapes, so the caller can skip rather than
 * invent a grouping.
 */
export function documentNumberFromSpruceOrderKey(spruceOrderId: string): string | null {
  const trimmed = spruceOrderId.trim();
  if (!trimmed) return null;

  // Legacy CSV imports stored the Spruce document number directly, without a
  // page/table/row suffix. Production has a small set of these six-digit keys;
  // digits-only is deliberately narrow so an arbitrary malformed coordinate
  // is not accepted as a document number.
  if (/^\d+$/.test(trimmed)) return trimmed;

  // Current shape: `<document>-L<line>`. Checked before the coordinate shapes,
  // whose trailing `-<number>` would otherwise match first and leave the `-L`.
  const lineKey = /^(.+?)-L\d+$/.exec(trimmed);
  if (lineKey) return lineKey[1] ?? null;

  // Text-extraction fallback: `<document>-T-<index>`. Checked first because its
  // `-T-` would otherwise be read as an empty table suffix.
  const textFallback = /^(.+?)-T-\d+$/.exec(trimmed);
  if (textFallback) return textFallback[1] ?? null;

  // Textract path: `<document>[-P<n>][-T<n>]-<row>`.
  const textract = /^(.+?)(?:-P\d+)?(?:-T\d+)?-\d+$/.exec(trimmed);
  if (textract) return textract[1] ?? null;

  return null;
}
