import { prisma } from '../../db/prisma.js';
import { parse } from 'csv-parse/sync';
import type { RawOrderCsvRow } from './orderCsvMapper.js';
import { mapCsvRowToOrder } from './orderCsvMapper.js';

export interface ImportSummary {
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ rowNumber: number; error: string }>;
}

export const OrderImportService = {
  async importFromCsv(buffer: Buffer): Promise<ImportSummary> {
    const csvText = buffer.toString('utf-8');

    const records = parse(csvText, {
      columns: true,         
      skip_empty_lines: true,
      trim: true,
    }) as RawOrderCsvRow[];

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: ImportSummary['errors'] = [];

    for (let i = 0; i < records.length; i++) {
      const rowNumber = i + 2; 

      const row = records[i];
      if (!row) continue;
      const { data, error } = mapCsvRowToOrder(row);

      if (error || !data) {
        skipped++;
        errors.push({ rowNumber, error: error ?? 'Unknown mapping error' });
        continue;
      }

      try {
        const existing = await prisma.order.findUnique({
          where: { spruceOrderId: data.spruceOrderId },
        });

        if (existing) {
          await prisma.order.update({
            where: { spruceOrderId: data.spruceOrderId },
            data: {
              poNumber: data.poNumber ?? null,
              customerName: data.customerName,
              buyerType: data.buyerType,
              product: data.product,
              quantity: data.quantity,
              unit: data.unit,
              orderDate: data.orderDate,
              deliveryDate: data.deliveryDate ?? null,
              hasInvoice: data.hasInvoice ?? false,
              invoiceNumber: data.invoiceNumber ?? null,
            },
          });
          updated++;
        } else {
          await prisma.order.create({ data });
          created++;
        }
      } catch (e: any) {
        skipped++;
        errors.push({
          rowNumber,
          error: e?.message || 'Database error',
        });
      }
    }

    return { created, updated, skipped, errors };
  },
};