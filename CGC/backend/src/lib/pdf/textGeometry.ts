import type { PdfTextRun } from './pdfWords.js';

/**
 * Turning positioned text back into table rows and columns.
 *
 * Everything here is derived from the page being read. Spruce reports are laid
 * out in the PDF's own coordinate space, and the extraction library reports
 * that space in units of its own choosing, so a boundary written as a constant
 * would be correct for one report and silently wrong for the next. Rows come
 * from the spacing actually present on the page, and columns from where the
 * header words actually sit.
 */

/** Runs sharing one visual line, left to right. */
export interface TextRow {
  /** Topmost y of the runs in this row. */
  y: number;
  runs: PdfTextRun[];
}

/** A column's horizontal extent, as `[x0, x1)`. */
export interface Band {
  key: string;
  x0: number;
  x1: number;
}

/** A column: the key to emit it under, and the header text that locates it. */
export interface ColumnSpec {
  key: string;
  /** Header text, matched case- and whitespace-insensitively. */
  phrase: string;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Gap above which two lines belong to different rows.
 *
 * Spruce does not put every part of a row on one exact baseline: an item's
 * description is often drawn a fraction above its item code, and a wrapped
 * description sits closer still. On the sample reports those within-row gaps
 * run to 0.32 while genuine row spacing starts at 0.58 — close enough that a
 * fixed threshold picked for one report splits rows in another.
 *
 * So the split is found rather than assumed: sorted gaps fall into a tight
 * cluster (jitter within a row) and a loose one (real row spacing), and the
 * widest proportional jump between them is the boundary. When no such jump
 * exists every line is its own row, which is the safe reading — merging two
 * real rows would attach one order's quantity to another's description.
 */
export function deriveRowTolerance(ys: number[]): number {
  const sorted = [...new Set(ys)].sort((a, b) => a - b);
  if (sorted.length < 2) return 0;

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]! - sorted[i - 1]!;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 0;

  const pitch = dominantRowPitch(gaps);
  if (pitch <= 0) return 0;

  // Under half a row's pitch. Comfortably above the largest within-row offset
  // seen on the sample reports (about a third of a pitch) and comfortably below
  // the tightest genuine row spacing.
  return pitch * ROW_TOLERANCE_FRACTION;
}

const ROW_TOLERANCE_FRACTION = 0.45;

/**
 * The report's usual line spacing.
 *
 * Read off as the upper quartile of the gaps: three gaps in four are no wider
 * than this, which on a ruled report is the spacing between rows.
 *
 * A plain average or median would sit too low. Roughly half the gaps on a dense
 * page are the near-zero jitter between parts of a single row — a description
 * drawn a fraction above its own item code — and counting those as spacing
 * would pull the estimate under a real row's height. The upper quartile stays
 * clear of them while ignoring the outsized gaps around headers and footers.
 */
function dominantRowPitch(gaps: number[]): number {
  const ascending = [...gaps].sort((a, b) => a - b);
  return ascending[Math.round((ascending.length - 1) * 0.75)]!;
}

/**
 * Groups runs into rows by vertical position.
 *
 * Pass `tolerance` to override the derived one; a page holding a single row
 * gives nothing to derive from.
 */
export function clusterRows(runs: PdfTextRun[], tolerance?: number): TextRow[] {
  if (runs.length === 0) return [];

  const tol = tolerance ?? deriveRowTolerance(runs.map(r => r.y));
  const byY = [...runs].sort((a, b) => a.y - b.y);

  const rows: TextRow[] = [];
  let current: PdfTextRun[] = [];
  let previousY = byY[0]!.y;

  for (const run of byY) {
    if (current.length > 0 && run.y - previousY > tol) {
      rows.push(finishRow(current));
      current = [];
    }
    current.push(run);
    previousY = run.y;
  }
  if (current.length > 0) rows.push(finishRow(current));

  return rows;
}

function finishRow(runs: PdfTextRun[]): TextRow {
  const ordered = [...runs].sort((a, b) => a.x - b.x);
  return { y: Math.min(...runs.map(r => r.y)), runs: ordered };
}

/** Where each column's header text was found. */
export interface HeaderMatch {
  row: TextRow;
  /** Column key to the run holding its header. Missing keys were not found. */
  hits: Map<string, PdfTextRun>;
}

/**
 * Finds the row carrying the column headers.
 *
 * The best-matching row wins rather than the first one over a threshold: these
 * reports repeat words like "Document" in their title block, and locking onto
 * that would put every column boundary in the wrong place.
 */
export function findHeaderRow(rows: TextRow[], columns: ColumnSpec[]): HeaderMatch | null {
  let best: HeaderMatch | null = null;
  let bestCount = 0;

  for (const row of rows) {
    const hits = new Map<string, PdfTextRun>();

    for (const column of columns) {
      const wanted = normalise(column.phrase);
      // A header cell may carry more than its own label when Spruce packs two
      // columns into one run, so containment is enough to locate it.
      const run = row.runs.find(r => normalise(r.text).includes(wanted));
      if (run) hits.set(column.key, run);
    }

    if (hits.size > bestCount) {
      bestCount = hits.size;
      best = { row, hits };
    }
  }

  return best;
}

/**
 * Turns header positions into column extents.
 *
 * Boundaries sit midway between neighbouring headers rather than on a header's
 * own x. Numeric columns are right-aligned, so their values begin to the *left*
 * of their heading — Qty on the item-tracking report is headed at 29.0 and
 * filled from 28.4 — and a boundary drawn at the heading would file every
 * quantity under the description beside it.
 *
 * Only columns whose header was found get a band; a report variant that omits
 * a column yields no band for it rather than a band covering its neighbour.
 */
export function deriveBands(header: HeaderMatch, pageWidth: number): Band[] {
  const found = [...header.hits.entries()]
    .map(([key, run]) => ({ key, x: run.x }))
    .sort((a, b) => a.x - b.x);

  if (found.length === 0) return [];

  return found.map((column, index) => {
    const previous = found[index - 1];
    const next = found[index + 1];

    return {
      key: column.key,
      x0: previous ? (previous.x + column.x) / 2 : Number.NEGATIVE_INFINITY,
      x1: next ? (column.x + next.x) / 2 : Math.max(pageWidth, column.x) + 1,
    };
  });
}

/**
 * Files a row's runs under their columns.
 *
 * Assignment is by a run's left edge. A description too long for its cell is
 * drawn overflowing into the column beside it, but it still *starts* in its own
 * column, so its left edge files it correctly where its width would not.
 * Anything left of the first band is ignored.
 */
export function assignToBands(row: TextRow, bands: Band[]): Record<string, PdfTextRun[]> {
  const cells: Record<string, PdfTextRun[]> = {};

  for (const run of row.runs) {
    const band = bands.find(b => run.x >= b.x0 && run.x < b.x1);
    if (!band) continue;
    (cells[band.key] ??= []).push(run);
  }

  return cells;
}

/** A cell's text, in reading order. */
export function joinRunText(runs: PdfTextRun[] | undefined): string {
  if (!runs || runs.length === 0) return '';
  return [...runs]
    .sort((a, b) => a.x - b.x)
    .map(r => r.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Convenience: a row's cells as plain text. */
export function rowText(row: TextRow, bands: Band[]): Record<string, string> {
  const cells = assignToBands(row, bands);
  const text: Record<string, string> = {};
  for (const [key, runs] of Object.entries(cells)) {
    const joined = joinRunText(runs);
    if (joined) text[key] = joined;
  }
  return text;
}
