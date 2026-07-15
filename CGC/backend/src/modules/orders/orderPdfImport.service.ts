import { TextractClient, AnalyzeDocumentCommand, type Block } from '@aws-sdk/client-textract';
import { PDFDocument } from 'pdf-lib';
import { PDFParse } from 'pdf-parse';
import { prisma } from '../../db/prisma.js';
import type { Prisma } from '@prisma/client';
import { orderEventEmitter, OrderEvents } from './order.events.js';

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

      let lastOrderId: string | undefined = undefined;
      let lastCustomerName: string | undefined = undefined;
      let lastEntryDateRaw: string | undefined = undefined;
      let lastDeliveryDateRaw: string | undefined = undefined;
      let lastPoNumber: string | null = null;

      for (let pageIdx = 0; pageIdx < pageCount; pageIdx++) {
        console.log(`[OrderPdfImport] Sending page ${pageIdx + 1} to Textract...`);

        // Create a new PDF containing only this page
        const subDoc = await PDFDocument.create();
        const [copiedPage] = await subDoc.copyPages(pdfDoc, [pageIdx]);
        subDoc.addPage(copiedPage);
        const pagePdfBytes = await subDoc.save();

        const params = {
          Document: {
            Bytes: pagePdfBytes,
          },
          FeatureTypes: ['TABLES' as any],
        };

        const command = new AnalyzeDocumentCommand(params);
        const response = await textractClient.send(command);

        if (!response.Blocks) {
          console.log(`[OrderPdfImport] Page ${pageIdx + 1}: No blocks returned from Textract.`);
          continue;
        }

        const tableBlocks = response.Blocks.filter((block) => block.BlockType === 'TABLE');
        console.log(`[OrderPdfImport] Page ${pageIdx + 1} found ${tableBlocks.length} tables.`);
        if (tableBlocks.length === 0) continue;

        for (const tableBlock of tableBlocks) {
          const cells = response.Blocks.filter(
            (block) =>
              block.BlockType === 'CELL' &&
              tableBlock.Relationships?.some((rel) => rel.Ids?.includes(block.Id || ''))
          );

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

          const getText = (cell: Block, blocks: Block[]): string => {
            if (!cell.Relationships) return '';
            let text = '';
            const words = cell.Relationships.filter((rel) => rel.Type === 'CHILD').flatMap((rel) => rel.Ids || []);
            words.forEach((wordId) => {
              const wordBlock = blocks.find((b) => b.Id === wordId);
              if (wordBlock && wordBlock.BlockType === 'WORD') {
                text += (wordBlock.Text || '') + ' ';
              }
            });
            return text.trim();
          };

          const headers: { [key: number]: string } = {};
          if (rows[1]) {
            rows[1].forEach((cell) => {
              if (cell.ColumnIndex !== undefined) {
                const headerText = getText(cell, response.Blocks || []).toLowerCase().replace(/\s+/g, '');
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
                  rowData[headerKey] = getText(cell, response.Blocks || []);
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
              errors.push({ rowNumber: rowIndex, error: `Page ${pageIdx + 1}, Row ${rowIndex}: Missing spruceOrderId="${spruceOrderId}", customerName="${customerName}", itemDesc="${itemDesc}"` });
              continue;
            }

            let orderDate = new Date();
            if (entryDateRaw) {
              const parsedDate = new Date(entryDateRaw);
              if (!isNaN(parsedDate.getTime())) orderDate = parsedDate;
            }

            let deliveryDate: Date | null = null;
            if (deliveryDateRaw) {
              const parsedDate = new Date(deliveryDateRaw);
              if (!isNaN(parsedDate.getTime())) deliveryDate = parsedDate;
            }

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
              spruceOrderId: `${spruceOrderId}-${rowIndex}`,
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
              errors.push({
                rowNumber: rowIndex,
                error: `Page ${pageIdx + 1}, Row ${rowIndex}: ${e?.message || 'Database error'}`,
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


