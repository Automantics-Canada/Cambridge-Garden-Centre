import { prisma } from '../../db/prisma.js';
import { parse } from 'csv-parse/sync';
import { mapCsvRowToOrder } from './orderCsvMapper.js';
import { saveCsvFile } from '../../services/fileStorage.js';
export const OrderService = {
    async getOrders(filters) {
        const { startDate, endDate, uploadStartDate, uploadEndDate, buyerType, supplierId, driverId, hasInvoice, hasLinkedTickets, search, page = 1, limit = 1000 } = filters;
        let where = {};
        if (driverId) {
            where.driverId = driverId;
        }
        if (startDate || endDate) {
            where.orderDate = {};
            if (startDate)
                where.orderDate.gte = new Date(startDate);
            if (endDate) {
                const end = new Date(endDate);
                end.setUTCHours(23, 59, 59, 999);
                where.orderDate.lte = end;
            }
        }
        if (uploadStartDate || uploadEndDate) {
            where.createdAt = {};
            if (uploadStartDate)
                where.createdAt.gte = new Date(uploadStartDate);
            if (uploadEndDate) {
                const end = new Date(uploadEndDate);
                end.setUTCHours(23, 59, 59, 999);
                where.createdAt.lte = end;
            }
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
            }
            else {
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
        const take = parseInt(limit, 10) || 1000;
        const skip = (parseInt(page, 10) - 1 || 0) * take;
        const [orders, total] = await Promise.all([
            prisma.order.findMany({
                where,
                take,
                skip,
                orderBy: { createdAt: 'desc' },
                include: {
                    supplier: true,
                    tickets: true,
                    ticketMatches: {
                        include: { ticket: true }
                    }
                }
            }),
            prisma.order.count({ where })
        ]);
        return {
            data: orders,
            pagination: {
                total,
                page: parseInt(page, 10) || 1,
                limit: take,
                totalPages: Math.ceil(total / take)
            }
        };
    }
};
export const OrderImportService = {
    async importFromCsv(buffer, originalName) {
        // Save file to Supabase Storage first
        let fileUrl = '';
        try {
            fileUrl = await saveCsvFile(buffer, originalName || 'orders-import.csv');
            console.log(`[OrderImport] CSV saved to Supabase: ${fileUrl}`);
        }
        catch (error) {
            console.error('[OrderImport] Failed to save CSV to storage, continuing with processing...', error);
        }
        let csvText = buffer.toString('utf-8');
        // Auto-detect if there are garbage metadata rows at the top
        const lines = csvText.split(/\r?\n/);
        const headerIndex = lines.findIndex(line => line.includes('Document,') || line.includes('OrderNumber,'));
        if (headerIndex > 0) {
            csvText = lines.slice(headerIndex).join('\n');
        }
        const records = parse(csvText, {
            bom: true,
            columns: true,
            skip_empty_lines: true,
            trim: true,
        });
        console.log("[OrderImport] First record keys:", Object.keys(records[0] || {}));
        console.log("[OrderImport] First record:", records[0]);
        let created = 0;
        let updated = 0;
        let skipped = 0;
        const errors = [];
        for (let i = 0; i < records.length; i++) {
            const rowNumber = i + 2;
            const row = records[i];
            if (!row)
                continue;
            const { data, error } = mapCsvRowToOrder(row);
            if (error || !data) {
                skipped++;
                // Include the actual keys we found so we can debug!
                const foundKeys = Object.keys(row).join(', ');
                errors.push({ rowNumber, error: `${error} (Found headers: ${foundKeys})` });
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
                            customerName: data.customerName ?? null,
                            buyerType: data.buyerType ?? null,
                            product: data.product ?? null,
                            quantity: data.quantity ?? null,
                            unit: data.unit ?? null,
                            orderDate: data.orderDate ?? null,
                            deliveryDate: data.deliveryDate ?? null,
                            hasInvoice: data.hasInvoice ?? false,
                            invoiceNumber: data.invoiceNumber ?? null,
                        },
                    });
                    updated++;
                }
                else {
                    await prisma.order.create({ data });
                    created++;
                }
            }
            catch (e) {
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
//# sourceMappingURL=order.service.js.map