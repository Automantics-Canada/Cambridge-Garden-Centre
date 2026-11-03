/**
 * What to make of an emailed attachment once its pages have been sorted.
 *
 * The inbox used to turn every attachment into an invoice. Suppliers send more
 * than invoices to AP (A15, and the statements and credit memos every AP
 * mailbox gets), and each of those became a "bill" of its own:
 *
 *   - a delivery ticket attached beside the invoice became a second invoice on
 *     the same PO, which tripped the duplicate-billing check against the real
 *     one and never reached the tickets the invoice is checked against;
 *   - an invoice PDF with its tickets stapled on the back was read whole, so
 *     ticket rows could come back as invoice lines;
 *   - a statement re-billed every invoice it listed.
 *
 * Each page is now sorted (extraction triageDocument, one small model call per
 * attachment) and this decides, purely, what is created: invoice pages become
 * one invoice, in their order; each ticket page becomes an emailed ticket;
 * statements, credit memos and anything else are recorded and nothing is
 * created from them.
 */
import type { DocumentKind, DocumentTriage } from './extraction/schemas.js';

export interface PagePlan {
  /** What every page is, numbered from 1, after filling any gap in the answer. */
  pages: Array<{ page: number; kind: DocumentKind }>;
  /** Pages that make up the invoice, in order. Empty when there is none. */
  invoicePages: number[];
  /** Pages that are one delivery ticket each. */
  ticketPages: number[];
  /**
   * False when the file is handled whole: an image, a spreadsheet, or a PDF
   * that could not be opened to split. Its one kind is then the document's.
   */
  split: boolean;
}

/**
 * When a file cannot be split, the one thing it is taken to be. An invoice
 * anywhere in it wins (the invoice reader is told to skip ticket pages), and
 * money the supplier owes CGC comes before paperwork that only informs.
 */
const WHOLE_FILE_ORDER: DocumentKind[] = ['invoice', 'credit_memo', 'statement', 'delivery_ticket', 'other'];

function wholeKind(kinds: readonly DocumentKind[]): DocumentKind {
  return WHOLE_FILE_ORDER.find((kind) => kinds.includes(kind)) ?? 'other';
}

/**
 * Turns the model's answer into a plan.
 *
 * `pageCount` is the PDF's real page count, or null when the file is handled
 * whole. A page the answer left out is put with the invoice when the file has
 * invoice pages: a missing invoice page would drop lines from the checks,
 * while an extra page is one the invoice reader is told to ignore. Otherwise
 * it is "other", which a person sees on the email's record. Answers for pages
 * the file does not have are dropped.
 */
export function planPages(triage: DocumentTriage, pageCount: number | null): PagePlan {
  const answered = new Map<number, DocumentKind>();
  for (const entry of triage.pages ?? []) {
    const page = Math.trunc(entry.page);
    if (!answered.has(page)) answered.set(page, entry.kind);
  }

  if (pageCount === null || pageCount <= 1) {
    const kind = wholeKind([...answered.values()]);
    return {
      pages: [{ page: 1, kind }],
      invoicePages: kind === 'invoice' ? [1] : [],
      ticketPages: kind === 'delivery_ticket' ? [1] : [],
      split: false,
    };
  }

  const hasInvoice = [...answered.entries()].some(([page, kind]) => kind === 'invoice' && page >= 1 && page <= pageCount);
  const pages = Array.from({ length: pageCount }, (_, index) => {
    const page = index + 1;
    return { page, kind: answered.get(page) ?? (hasInvoice ? 'invoice' : 'other') } as const;
  });
  return {
    pages: pages.map((p) => ({ ...p })),
    invoicePages: pages.filter((p) => p.kind === 'invoice').map((p) => p.page),
    ticketPages: pages.filter((p) => p.kind === 'delivery_ticket').map((p) => p.page),
    split: true,
  };
}

/** The plan when the pages could not be sorted at all: the old behaviour, one invoice. */
export function unsortedPlan(): PagePlan {
  return { pages: [{ page: 1, kind: 'invoice' }], invoicePages: [1], ticketPages: [], split: false };
}

const KIND_WORDS: Record<DocumentKind, [string, string]> = {
  invoice: ['invoice', 'invoice'],
  delivery_ticket: ['delivery ticket', 'delivery tickets'],
  statement: ['statement (not billed)', 'statement (not billed)'],
  credit_memo: ['credit memo (enter by hand)', 'credit memo (enter by hand)'],
  other: ['not an invoice or ticket', 'not an invoice or ticket'],
};

function pageRange(pages: number[]): string {
  const runs: string[] = [];
  let start = pages[0]!;
  let previous = start;
  for (const page of [...pages.slice(1), Number.NaN]) {
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    runs.push(start === previous ? String(start) : `${start}-${previous}`);
    start = page;
    previous = page;
  }
  return runs.join(', ');
}

/**
 * One line for the email's record, e.g. "pages 1-2 invoice; page 3 delivery
 * ticket; page 4 statement (not billed)". A single-page file says only what it
 * is.
 */
export function describePages(pages: ReadonlyArray<{ page: number; kind: DocumentKind }>): string {
  if (pages.length === 0) return '';
  if (pages.length === 1) return KIND_WORDS[pages[0]!.kind][0];
  const byKind = new Map<DocumentKind, number[]>();
  for (const { page, kind } of pages) byKind.set(kind, [...(byKind.get(kind) ?? []), page]);
  return [...byKind.entries()]
    .sort((a, b) => a[1][0]! - b[1][0]!)
    .map(([kind, list]) => `${list.length === 1 ? 'page' : 'pages'} ${pageRange(list)} ${KIND_WORDS[kind][list.length === 1 ? 0 : 1]}`)
    .join('; ');
}
