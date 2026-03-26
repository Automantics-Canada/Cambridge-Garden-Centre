import type { BuyerType, Prisma } from '@prisma/client';

export type RawOrderCsvRow = Record<string, string>;

export interface ParsedOrderRow {
  data?: Prisma.OrderUncheckedCreateInput;
  error?: string;
}

function parseBoolean(value: string | undefined | null): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return ['yes', 'true', '1', 'y'].includes(v);
}

function parseDate(value: string | undefined | null): Date | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const d = new Date(trimmed);
  if (isNaN(d.getTime())) {
    return undefined;
  }
  return d;
}

export function mapCsvRowToOrder(row: RawOrderCsvRow): ParsedOrderRow {
  const orderNumber = row['OrderNumber']?.trim();
  const customerName = row['CustomerName']?.trim();
  const buyerTypeRaw = row['BuyerType']?.trim().toUpperCase();
  const product = row['Product']?.trim();
  const quantityRaw = row['Quantity']?.trim();
  const unit = row['Unit']?.trim();
  const poNumber = row['PONumber']?.trim() || null;
  const orderDateRaw = row['OrderDate']?.trim();
  const deliveryDateRaw = row['DeliveryDate']?.trim();
  const invoiceNumber = row['InvoiceNumber']?.trim() || null;
  const hasInvoiceRaw = row['HasInvoice']?.trim();

  if (!orderNumber) {
    return { error: 'OrderNumber is required' };
  }
  if (!customerName) {
    return { error: 'CustomerName is required' };
  }
  if (!buyerTypeRaw) {
    return { error: 'BuyerType is required' };
  }
  if (!product) {
    return { error: 'Product is required' };
  }
  if (!quantityRaw) {
    return { error: 'Quantity is required' };
  }
  if (!unit) {
    return { error: 'Unit is required' };
  }
  if (!orderDateRaw) {
    return { error: 'OrderDate is required' };
  }

  let buyerType: BuyerType;
  if (buyerTypeRaw === 'RETAIL' || buyerTypeRaw === 'CONTRACTOR') {
    buyerType = buyerTypeRaw as BuyerType;
  } else {
    return { error: `Invalid BuyerType: ${buyerTypeRaw}` };
  }

  const orderDate = parseDate(orderDateRaw);
  if (!orderDate) {
    return { error: `Invalid OrderDate: ${orderDateRaw}` };
  }

  const deliveryDate = parseDate(deliveryDateRaw ?? undefined);

  const quantity = quantityRaw;

  const hasInvoice = hasInvoiceRaw ? parseBoolean(hasInvoiceRaw) : !!invoiceNumber;

  const data: Prisma.OrderUncheckedCreateInput = {
    spruceOrderId: orderNumber,
    poNumber,
    customerName,
    buyerType,
    product,
    quantity,
    unit,
    orderDate,
    deliveryDate: deliveryDate ?? null,
    hasInvoice,
    invoiceNumber,
  };

  return { data };
}
