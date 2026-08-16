import { TextractClient, AnalyzeDocumentCommand, type Block } from '@aws-sdk/client-textract';
import { PDFDocument } from 'pdf-lib';

/**
 * Reads a Spruce PDF report into header-keyed rows.
 *
 * Extracted so the second report in the two-step merge does not need its own
 * copy of the Textract plumbing. The delivery-report importer still has its
 * own inline version; that one carries row-to-row carry-forward state and is
 * left alone rather than refactored underneath a working import.
 *
 * Header keys are lower-cased with whitespace removed, matching the convention
 * the delivery importer already uses.
 */

const textractClient = new TextractClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

export interface PdfTableRow {
  pageNumber: number;
  rowNumber: number;
  cells: Record<string, string>;
}

/**
 * Text of one CELL block.
 *
 * Blocks are indexed by id first. The delivery importer does
 * `blocks.find(b => b.Id === wordId)` inside a loop over every word of every
 * cell, which is quadratic in the page's block count; a page with a large table
 * spends most of its time in that scan.
 */
function cellText(cell: Block, blocksById: Map<string, Block>): string {
  if (!cell.Relationships) return '';

  const words: string[] = [];
  for (const rel of cell.Relationships) {
    if (rel.Type !== 'CHILD' || !rel.Ids) continue;
    for (const id of rel.Ids) {
      const block = blocksById.get(id);
      if (block?.BlockType === 'WORD' && block.Text) words.push(block.Text);
    }
  }

  return words.join(' ').trim();
}

export async function readPdfTableRows(buffer: Buffer, maxPages = 40): Promise<PdfTableRow[]> {
  const pdfDoc = await PDFDocument.load(buffer);
  const pageCount = Math.min(pdfDoc.getPageCount(), maxPages);

  const pageDocuments: Uint8Array[] = [];
  for (let pageIdx = 0; pageIdx < pageCount; pageIdx++) {
    const subDoc = await PDFDocument.create();
    const [copiedPage] = await subDoc.copyPages(pdfDoc, [pageIdx]);
    if (!copiedPage) throw new Error(`Unable to copy PDF page ${pageIdx + 1}`);
    subDoc.addPage(copiedPage);
    pageDocuments.push(await subDoc.save());
  }

  // OCR is the network-bound step; a few pages in flight keeps the wall time
  // down without stampeding Textract's rate limit.
  const pageBlocks: Array<Block[] | undefined> = new Array(pageCount);
  let nextPage = 0;
  const workers = Math.min(3, pageCount);

  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const pageIdx = nextPage++;
      if (pageIdx >= pageCount) return;
      const response = await textractClient.send(new AnalyzeDocumentCommand({
        Document: { Bytes: pageDocuments[pageIdx] },
        FeatureTypes: ['TABLES'],
      }));
      pageBlocks[pageIdx] = response.Blocks;
    }
  }));

  const rows: PdfTableRow[] = [];

  for (let pageIdx = 0; pageIdx < pageCount; pageIdx++) {
    const blocks = pageBlocks[pageIdx];
    if (!blocks) continue;

    const blocksById = new Map(blocks.map(b => [b.Id ?? '', b]));
    const cellIdsByTable = new Map<string, Set<string>>();

    for (const table of blocks.filter(b => b.BlockType === 'TABLE')) {
      const ids = new Set<string>();
      for (const rel of table.Relationships ?? []) {
        for (const id of rel.Ids ?? []) ids.add(id);
      }
      cellIdsByTable.set(table.Id ?? '', ids);
    }

    for (const [, cellIds] of cellIdsByTable) {
      const cells = blocks.filter(b => b.BlockType === 'CELL' && cellIds.has(b.Id ?? ''));
      if (cells.length === 0) continue;

      const byRow = new Map<number, Block[]>();
      for (const cell of cells) {
        if (cell.RowIndex === undefined) continue;
        const existing = byRow.get(cell.RowIndex);
        if (existing) existing.push(cell);
        else byRow.set(cell.RowIndex, [cell]);
      }

      const headerCells = byRow.get(1) ?? [];
      const headers = new Map<number, string>();
      for (const cell of headerCells) {
        if (cell.ColumnIndex === undefined) continue;
        headers.set(cell.ColumnIndex, cellText(cell, blocksById).toLowerCase().replace(/\s+/g, ''));
      }

      for (const rowIndex of [...byRow.keys()].sort((a, b) => a - b)) {
        if (rowIndex === 1) continue;

        const cellsForRow: Record<string, string> = {};
        for (const cell of byRow.get(rowIndex) ?? []) {
          if (cell.ColumnIndex === undefined) continue;
          const header = headers.get(cell.ColumnIndex);
          if (header) cellsForRow[header] = cellText(cell, blocksById);
        }

        if (Object.keys(cellsForRow).length > 0) {
          rows.push({ pageNumber: pageIdx + 1, rowNumber: rowIndex, cells: cellsForRow });
        }
      }
    }
  }

  return rows;
}

/**
 * First non-empty value among the given header aliases.
 *
 * Exact match wins over a partial one, so a column literally named `po` is not
 * beaten by `podocument` appearing earlier in the row.
 */
export function findCell(cells: Record<string, string>, aliases: string[]): string | undefined {
  for (const alias of aliases) {
    const value = cells[alias];
    if (value) return value;
  }
  for (const alias of aliases) {
    const key = Object.keys(cells).find(k => k.includes(alias));
    if (key && cells[key]) return cells[key];
  }
  return undefined;
}
