import { prisma } from '../../db/prisma.js';
import { parse } from 'csv-parse/sync';
import type { RawOrderCsvRow } from './orderCsvMapper.js';
import { mapCsvRowToOrder } from './orderCsvMapper.js';
import { saveCsvFile } from '../../services/fileStorage.js';

export interface ImportSummary {
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ rowNumber: number; error: string }>;
}

export const OrderService = {
  async getOrders(filters: any) {
    const { startDate, endDate, buyerType, supplierId, hasInvoice, hasLinkedTickets, search } = filters;
    
    let where: any = {};

    if (startDate || endDate) {
      where.orderDate = {};
      if (startDate) where.orderDate.gte = new Date(startDate);
      if (endDate) where.orderDate.lte = new Date(endDate);
    }

    if (buyerType) {
      where.buyerType = buyerType;
    }

    if (supplierId) {
      where.supplierId = supplierId; // uuid
    }

    if (hasInvoice !== undefined) {
      where.hasInvoice = hasInvoice === 'true' || hasInvoice === true;
    }

    if (hasLinkedTickets !== undefined) {
      const bHasLinkedTickets = hasLinkedTickets === 'true' || hasLinkedTickets === true;
      if (bHasLinkedTickets) {
        where.tickets = { some: {} };
      } else {
        where.tickets = { none: {} };
      }
    }

    if (search) {
      where.OR = [
        { spruceOrderId: { contains: search, mode: 'insensitive' } },
        { poNumber: { contains: search, mode: 'insensitive' } },
        { customerName: { contains: search, mode: 'insensitive' } },
        { product: { contains: search, mode: 'insensitive' } }
      ];
    }

    const orders = await prisma.order.findMany({
      where,
      orderBy: { orderDate: 'desc' },
      include: {
        supplier: true,
        tickets: true
      }
    });
    
    return orders;
  }
};

export const OrderImportService = {
  async importFromCsv(buffer: Buffer, originalName?: string): Promise<ImportSummary> {
    // Save file to Supabase Storage first
    let fileUrl = '';
    try {
      fileUrl = await saveCsvFile(buffer, originalName || 'orders-import.csv');
      console.log(`[OrderImport] CSV saved to Supabase: ${fileUrl}`);
    } catch (error) {
      console.error('[OrderImport] Failed to save CSV to storage, continuing with processing...', error);
    }

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