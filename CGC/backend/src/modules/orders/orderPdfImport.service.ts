import { TextractClient, AnalyzeDocumentCommand, type Block } from '@aws-sdk/client-textract';
import { PDFDocument } from 'pdf-lib';
import { PDFParse } from 'pdf-parse';
import { prisma } from '../../db/prisma.js';
import type { Prisma } from '@prisma/client';
import { orderEventEmitter, OrderEvents } from './order.events.js';
import { buildSpruceOrderKey } from './orderImportKey.js';
import { parseSpruceDate } from '../../lib/spruceDate.js';

const textractClient = new TextractClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

export interface ImportSummary {
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ rowNumber: number; error: string }>;
}

/**
 * Unit of measure for a line, read from its description.
 *
 * This was `descLower.includes('mt')` and `includes('cy')`, which match inside
 * ordinary words — "Fancy Mulch" contains "cy", so it was priced by the cubic
 * yard. Matching is now on whole tokens, and an unrecognised description keeps
 * the previous 'EA' default rather than inventing a measure.
 */
export function inferUnitFromDescription(description: string): string {
  const tokens = description.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  if (tokens.some(t => t === 'mt' || t === 'tonne' || t === 'tonnes')) return 'MT';
  if (tokens.some(t => t === 'cy' || t === 'yd' || t === 'yds')) return 'CY';
  if (tokens.some(t => t === 'skid' || t === 'skids' || t === 'pallet' || t === 'pallets')) return 'Skid';
  if (tokens.some(t => t === 'ton' || t === 'tons')) return 'TON';

  return 'EA';
}

/**
 * Finds or creates the OrderDocument for a Spruce document number.
 *
 * The document number is the join key between the delivery report and the PO
 * report, so it is created on first sight and its header fields are refreshed
 * from whichever report supplies them. `poNumber` is only ever widened — the
 * delivery report often omits it and the PO report supplies it, and a later
 * import that lacks it must not erase what an earlier one established.
 */
async function upsertOrderDocument(input: {
  documentNumber: string;
  customerName: string;
  poNumber: string | null;
  orderDate: Date;
  deliveryDate: Date | null;
}) {
  const { documentNumber, customerName, poNumber, orderDate, deliveryDate } = input;

  return prisma.orderDocument.upsert({
    where: { documentNumber },
    update: {
      customerName,
      orderDate,
      ...(deliveryDate ? { deliveryDate } : {}),
      ...(poNumber ? { poNumber } : {}),
    },
    create: {
      documentNumber,
      customerName,
      poNumber,
      orderDate,
      deliveryDate,
    },
    select: { id: true },
  });
}

export const OrderPdfImportService = {
  async importFromPdf(buffer: Buffer, jobId: string): Promise<ImportSummary> {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: ImportSummary['errors'] = [];

    try {
      console.log('[OrderPdfImport] Attempting PDF split via pdf-lib...');
      const pdfDoc = await PDFDocument.load(buffer);
      const pageCount = pdfDoc.getPageCount();
      console.log(`[OrderPdfImport] Processing ${pageCount} pages...`);

      // The supplier list was loaded here to guess an order's supplier from the
      // customer's name. That inference is gone, so the query is too.

      // Splitting is local and fast. OCR is the expensive network operation, so
      // process a few pages concurrently while keeping parsing in page order.
      const pageDocuments: Uint8Array[] = [];
      for (let pageIdx = 0; pageIdx < pageCount; pageIdx++) {
        const subDoc = await PDFDocument.create();
        const [copiedPage] = await subDoc.copyPages(pdfDoc, [pageIdx]);
        if (!copiedPage) {
          throw new Error(`Unable to copy PDF page ${pageIdx + 1}`);
        }
        subDoc.addPage(copiedPage);
        pageDocuments.push(await subDoc.save());
      }

      const pageBlocks: Array<Block[] | undefined> = new Array(pageCount);
      let nextPageIndex = 0;
      const workerCount = Math.min(3, pageCount);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (true) {
          const pageIdx = nextPageIndex++;
          if (pageIdx >= pageCount) return;

          console.log(`[OrderPdfImport] Sending page ${pageIdx + 1} to Textract...`);
          const response = await textractClient.send(new AnalyzeDocumentCommand({
            Document: { Bytes: pageDocuments[pageIdx] },
            FeatureTypes: ['TABLES'],
          }));
          pageBlocks[pageIdx] = response.Blocks;
        }
      }));

      // Line numbers are assigned per document across the whole upload, so a
      // document whose lines span a page break keeps numbering continuously
      // instead of restarting at 1 and colliding with its own earlier lines.
      const lineCounters = new Map<string, number>();

      let lastOrderId: string | undefined = undefined;
      let lastCustomerName: string | undefined = undefined;
      let lastEntryDateRaw: string | undefined = undefined;
      let lastDeliveryDateRaw: string | undefined = undefined;
      let lastPoNumber: string | null = null;

      for (let pageIdx = 0; pageIdx < pageCount; pageIdx++) {
        const blocks = pageBlocks[pageIdx];
        if (!blocks) {
          console.log(`[OrderPdfImport] Page ${pageIdx + 1}: No blocks returned from Textract.`);
          continue;
        }

        // Index the page's blocks once.
        //
        // Every lookup below used to be a linear scan of the whole page:
        // `blocks.find(b => b.Id === wordId)` ran for each word of each cell,
        // and the cell list was rebuilt by scanning all blocks per table. On a
        // page whose table holds a few thousand blocks that is millions of
        // comparisons per page, all of it CPU on the same event loop that
        // serves the dispatch board.
        const blocksById = new Map<string, Block>();
        const cellsByTableId = new Map<string, Block[]>();
        const tableIdByCellId = new Map<string, string>();

        for (const block of blocks) {
          if (block.Id) blocksById.set(block.Id, block);
        }

        for (const block of blocks) {
          if (block.BlockType !== 'TABLE') continue;
          cellsByTableId.set(block.Id ?? '', []);
          for (const rel of block.Relationships ?? []) {
            for (const id of rel.Ids ?? []) tableIdByCellId.set(id, block.Id ?? '');
          }
        }

        for (const block of blocks) {
          if (block.BlockType !== 'CELL' || !block.Id) continue;
          const tableId = tableIdByCellId.get(block.Id);
          if (tableId !== undefined) cellsByTableId.get(tableId)?.push(block);
        }

        const tableBlocks = blocks.filter((block) => block.BlockType === 'TABLE');
        console.log(`[OrderPdfImport] Page ${pageIdx + 1} found ${tableBlocks.length} tables.`);
        if (tableBlocks.length === 0) continue;

        for (let tableIdx = 0; tableIdx < tableBlocks.length; tableIdx++) {
          const tableBlock = tableBlocks[tableIdx]!;
          const cells = cellsByTableId.get(tableBlock.Id ?? '') ?? [];

          const rows: { [key: number]: Block[] } = {};
          cells.forEach((cell) => {
            const rowIndex = cell.RowIndex;
            if (rowIndex !== undefined) {
              if (!rows[rowIndex]) {
                rows[rowIndex] = [];
              }
              rows[rowIndex].push(cell);
            }
          });

          const getText = (cell: Block): string => {
            if (!cell.Relationships) return '';
            const words: string[] = [];
            for (const rel of cell.Relationships) {
              if (rel.Type !== 'CHILD' || !rel.Ids) continue;
              for (const wordId of rel.Ids) {
                const wordBlock = blocksById.get(wordId);
                if (wordBlock?.BlockType === 'WORD' && wordBlock.Text) words.push(wordBlock.Text);
              }
            }
            return words.join(' ').trim();
          };

          const headers: { [key: number]: string } = {};
          if (rows[1]) {
            rows[1].forEach((cell) => {
              if (cell.ColumnIndex !== undefined) {
                const headerText = getText(cell).toLowerCase().replace(/\s+/g, '');
                headers[cell.ColumnIndex] = headerText;
              }
            });
            console.log(`[OrderPdfImport] Page ${pageIdx + 1} - ALL Detected Headers (colIndex -> name):`, headers);
          }

          const rowKeys = Object.keys(rows).map(Number).sort((a, b) => a - b);
          for (const rowIndex of rowKeys) {
            if (rowIndex === 1) continue;

            const rowCells = rows[rowIndex];
            const rowData: { [key: string]: string } = {};

            rowCells?.forEach((cell) => {
              const colIdx = cell.ColumnIndex;
              if (colIdx !== undefined) {
                const headerKey = headers[colIdx];
                if (headerKey !== undefined) {
                  rowData[headerKey] = getText(cell);
                }
              }
            });

            console.log(`[OrderPdfImport] Row ${rowIndex} raw data:`, rowData);

            // Flexible header matching - handle Spruce PDF header variations
            const findField = (keys: string[]): string | undefined => {
              // 1. Exact match first
              for (const key of keys) {
                const found = Object.keys(rowData).find(h => h === key);
                if (found && rowData[found]) return rowData[found];
              }
              // 2. Contains match (key inside header)
              for (const key of keys) {
                const found = Object.keys(rowData).find(h => h.includes(key));
                if (found && rowData[found]) return rowData[found];
              }
              return undefined;
            };

            let spruceOrderId = findField(['document', 'doc#', 'doc', 'order#', 'orderid', 'id', 'docno', 'documentno']);
            let customerName = findField(['customername', 'customer', 'client', 'billto', 'name']);
            let itemDesc = findField(['itemdesc', 'description', 'item', 'product', 'material', 'itemname', 'desc']);
            let deliveryDateRaw = findField(['deliverydate', 'delivery', 'deldate', 'shipdate', 'requireddate']);
            let entryDateRaw = findField(['entrydate', 'entry', 'orderdate', 'date', 'created']);
            const qtyRaw = findField(['qty', 'quantity', 'ordered', 'qtyordered', 'units']);
            const poRaw = findField(['podocument', 'ponumber', 'po#', 'po', 'purchaseorder', 'ponum']);
            const notesRaw = findField(['ordernotes', 'notes', 'memo', 'reference']);
            let poNumber = poRaw || notesRaw?.match(/PO[:\s]*([A-Za-z0-9\-\.]+)/i)?.[1] || null;

            if (spruceOrderId) lastOrderId = spruceOrderId;
            else spruceOrderId = lastOrderId;

            if (customerName) {
              customerName = customerName.replace(/^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}\s+/, '').trim();
              lastCustomerName = customerName;
            } else {
              customerName = lastCustomerName;
            }

            if (entryDateRaw) lastEntryDateRaw = entryDateRaw;
            else entryDateRaw = lastEntryDateRaw;

            if (deliveryDateRaw) lastDeliveryDateRaw = deliveryDateRaw;
            else deliveryDateRaw = lastDeliveryDateRaw;

            if (poNumber) lastPoNumber = poNumber;
            else poNumber = lastPoNumber;

            // If itemDesc is missing, it's a blank or total row, skip without logging an error unless we have nothing
            if (!itemDesc) {
              skipped++;
              continue; 
            }

            if (!spruceOrderId || !customerName) {
              console.log(`[OrderPdfImport] Skipping row ${rowIndex}: Missing required fields`, { spruceOrderId, customerName, itemDesc });
              skipped++;
              errors.push({ rowNumber: rowIndex, error: `Page ${pageIdx + 1}, Table ${tableIdx + 1}, Row ${rowIndex}: Missing spruceOrderId="${spruceOrderId}", customerName="${customerName}", itemDesc="${itemDesc}"` });
              continue;
            }

            // Explicit parsing: `new Date("05/06/24")` reads month-first in V8,
            // so a Canadian report saying 5 June was stored as 6 May.
            const orderDate = parseSpruceDate(entryDateRaw) ?? new Date();
            if (entryDateRaw && !parseSpruceDate(entryDateRaw)) {
              errors.push({
                rowNumber: rowIndex,
                error: `Page ${pageIdx + 1}, Row ${rowIndex}: unreadable entry date "${entryDateRaw}"; used today's date`,
              });
            }

            const deliveryDate = parseSpruceDate(deliveryDateRaw);

            const quantity = parseFloat(qtyRaw?.replace(/,/g, '') || '0') || 0;
            const unit = inferUnitFromDescription(itemDesc);

            // Supplier is deliberately not inferred here.
            //
            // This used to check whether any supplier's name *contained* the
            // customer's name, which is backwards twice over: the customer is
            // who buys from the yard, the supplier is who sells to it, and a
            // short customer name matches half the supplier table by substring.
            // A wrong supplierId then decides which negotiated rates an invoice
            // is checked against, so guessing here costs real money.
            //
            // The supplier for an order comes from the PO report merge or from
            // a person, never from the customer's name.
            const supplierId: string | null = null;

            const data: Prisma.OrderUncheckedCreateInput = {
              spruceOrderId: buildSpruceOrderKey({
                documentId: spruceOrderId,
                pageIndex: pageIdx,
                tableIndex: tableIdx,
                rowIndex,
              }),
              poNumber,
              customerName,
              supplierId,
              // buyerType is deliberately not set: the report does not say, and
              // stamping CONTRACTOR on every row hid the B2C side of the
              // business entirely. The column's default applies instead, which
              // records it as an assumption rather than something read off the
              // page. See the schema comment on Order.buyerType.
              product: itemDesc,
              quantity: quantity.toString(),
              unit,
              orderDate,
              deliveryDate,
              hasInvoice: false,
            };

            try {
              // Attach the row to its Spruce document and number it within that
              // document. This is the identity a re-import matches on:
              // `spruceOrderId` encodes the row's position in the PDF, so
              // inserting one row in Spruce shifts every row below it onto a
              // new key and duplicates orders that already exist.
              const document = await upsertOrderDocument({
                documentNumber: spruceOrderId,
                customerName,
                poNumber,
                orderDate,
                deliveryDate,
              });

              const lineNumber = (lineCounters.get(document.id) ?? 0) + 1;
              lineCounters.set(document.id, lineNumber);

              // Prefer the stable identity; fall back to the legacy positional
              // key so rows imported before this change are adopted and updated
              // rather than duplicated alongside their replacement.
              const existing =
                (await prisma.order.findFirst({
                  where: { documentId: document.id, lineNumber },
                  select: { id: true },
                }))
                ?? (await prisma.order.findUnique({
                  where: { spruceOrderId: data.spruceOrderId },
                  select: { id: true },
                }));

              const payload = { ...data, documentId: document.id, lineNumber };

              if (existing) {
                const updatedObj = await prisma.order.update({ where: { id: existing.id }, data: payload });
                updated++;
                orderEventEmitter.emit(OrderEvents.PDF_IMPORT_PROGRESS, { jobId, action: 'updated', order: updatedObj });
              } else {
                const createdObj = await prisma.order.create({ data: payload });
                created++;
                orderEventEmitter.emit(OrderEvents.PDF_IMPORT_PROGRESS, { jobId, action: 'created', order: createdObj });
              }
            } catch (e: any) {
              skipped++;
              errors.push({
                rowNumber: rowIndex,
                error: `Page ${pageIdx + 1}, Table ${tableIdx + 1}, Row ${rowIndex}: ${e?.message || 'Database error'}`,
              });
            }
          }
        }
      }
    } catch (err: any) {
      console.error('[OrderPdfImport] Critical error:', err);
      errors.push({ rowNumber: 0, error: `Critical error: ${err.message}` });
      orderEventEmitter.emit(OrderEvents.PDF_IMPORT_ERROR, { jobId, error: err.message });
      return { created, updated, skipped, errors };
    }

    const summary = { created, updated, skipped, errors };
    orderEventEmitter.emit(OrderEvents.PDF_IMPORT_DONE, { jobId, summary });
    return summary;
  },

  /**
   * Fallback method for when Textract/PNG conversion fails.
   * Extracts text directly from PDF using PDFParse class.
   */
  async importViaTextExtraction(buffer: Buffer, jobId: string): Promise<ImportSummary> {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: ImportSummary['errors'] = [];

    try {
      const pdfParser = new PDFParse({ data: buffer });
      const data = await pdfParser.getText();
      const lines = data.text.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
      
      console.log(`[OrderPdfImport] Extracted ${lines.length} lines via pdf-parse.`);
      console.log(`[OrderPdfImport] Sample lines:`, lines.slice(0, 10));

      // Since structure is "fixed", we look for lines that look like data rows.
      // A data row usually starts with a Document ID (number)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        
        // Broad regex: [ID] [DATE] [DATE] ...
        // Supports: 123456 05/06/24 05/07/24  OR  INV-123 2024-05-06 2024-05-07
        const match = line.match(/^([A-Za-z0-9\-]+)\s+(\d{1,4}[-/]\d{1,2}[-/]\d{2,4})\s+(\d{1,4}[-/]\d{1,2}[-/]\d{2,4})/);
        if (match) {
          const spruceOrderId = match[1];
          const entryDateRaw = match[2];
          const deliveryDateRaw = match[3];

          console.log(`[OrderPdfImport] Potential row match:`, { spruceOrderId, entryDateRaw, deliveryDateRaw });

          // Reconstruct the rest of the fields by splitting by multiple spaces
          const parts = line.split(/\s{2,}/);
          if (parts.length >= 5) {
            const customerName = parts[3] || 'Unknown Customer';
            const itemDesc = parts[4] || 'Unknown Item';
            const qtyRaw = parts[5];
            const orderNotes = parts[6] || '';
            const poNumber = orderNotes.match(/PO[:\s]*([A-Za-z0-9\-\.]+)/i)?.[1] || null;

            console.log(`[OrderPdfImport] Extracted data:`, { customerName, itemDesc, qtyRaw, poNumber });

            let orderDate = entryDateRaw ? new Date(entryDateRaw) : new Date();
            let deliveryDate = deliveryDateRaw ? new Date(deliveryDateRaw) : new Date();
            const quantity = parseFloat(qtyRaw?.replace(/,/g, '') || '0') || 0;

            let unit = 'EA';
            const descLower = itemDesc.toLowerCase();
            if (descLower.includes('mt')) unit = 'MT';
            else if (descLower.includes('cy')) unit = 'CY';
            else if (descLower.includes('skid')) unit = 'Skid';

            // Find supplierId if possible
            let supplierId: string | null = null;
            if (customerName) {
              const foundSupplier = await prisma.supplier.findFirst({
                where: { name: { contains: customerName, mode: 'insensitive' } },
              });
              if (foundSupplier) {
                supplierId = foundSupplier.id;
              }
            }

            const data: Prisma.OrderUncheckedCreateInput = {
              spruceOrderId: `${spruceOrderId}-T-${i}`, // -T- for Text extraction
              poNumber,
              customerName,
              supplierId,
              buyerType: 'CONTRACTOR',
              product: itemDesc,
              quantity: quantity.toString(),
              unit,
              orderDate,
              deliveryDate,
              hasInvoice: false,
            };

            try {
              const existing = await prisma.order.findUnique({
                where: { spruceOrderId: data.spruceOrderId },
              });

              if (existing) {
                const updatedObj = await prisma.order.update({ where: { spruceOrderId: data.spruceOrderId }, data });
                updated++;
                orderEventEmitter.emit(OrderEvents.PDF_IMPORT_PROGRESS, { jobId, action: 'updated', order: updatedObj });
              } else {
                const createdObj = await prisma.order.create({ data });
                created++;
                orderEventEmitter.emit(OrderEvents.PDF_IMPORT_PROGRESS, { jobId, action: 'created', order: createdObj });
              }
            } catch (e: any) {
              skipped++;
              errors.push({ rowNumber: i, error: `Row ${i}: ${e?.message}` });
            }
          }
        }
      }
    } catch (err: any) {
      console.error('[OrderPdfImport] Text extraction error:', err);
      errors.push({ rowNumber: 0, error: `Text extraction error: ${err.message}` });
      orderEventEmitter.emit(OrderEvents.PDF_IMPORT_ERROR, { jobId, error: err.message });
      return { created, updated, skipped, errors };
    }

    const summary = { created, updated, skipped, errors };
    orderEventEmitter.emit(OrderEvents.PDF_IMPORT_DONE, { jobId, summary });
    return summary;
  }
};


