function parseBoolean(value) {
    if (!value)
        return false;
    const v = value.trim().toLowerCase();
    return ['yes', 'true', '1', 'y'].includes(v);
}
function parseDate(value) {
    if (!value)
        return undefined;
    const trimmed = value.trim();
    if (!trimmed)
        return undefined;
    const d = new Date(trimmed);
    if (isNaN(d.getTime())) {
        return undefined;
    }
    return d;
}
export function mapCsvRowToOrder(row) {
    const orderNumber = row['OrderNumber']?.trim() || row['Document']?.trim();
    // Handle the merged Entry Date / Customer Name column
    const entryDateRaw = row['Entry Date']?.trim() || '';
    const entryDateParts = entryDateRaw.split(' ');
    const extractedOrderDate = entryDateParts.length > 0 ? entryDateParts[0] : '';
    const extractedCustomerName = entryDateParts.length > 1 ? entryDateParts.slice(1).join(' ') : '';
    const customerName = row['CustomerName']?.trim() || row['Customer Name']?.trim() || extractedCustomerName;
    const buyerTypeRaw = row['BuyerType']?.trim().toUpperCase() || 'RETAIL';
    const product = row['Product']?.trim() || row['Item Desc']?.trim() || row['Item Number']?.trim();
    const rawQty = row['Quantity']?.trim() || row['Qty']?.trim() || '';
    const quantityRaw = rawQty.match(/[\d.]+/)?.[0] || '';
    const unit = row['Unit']?.trim() || 'each';
    const poNumber = row['PONumber']?.trim() || row['PO Document']?.trim() || null;
    const orderDateRaw = row['OrderDate']?.trim() || extractedOrderDate;
    const deliveryDateRaw = row['DeliveryDate']?.trim() || row['Delivery Date']?.trim();
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
    let buyerType;
    if (buyerTypeRaw === 'RETAIL' || buyerTypeRaw === 'CONTRACTOR') {
        buyerType = buyerTypeRaw;
    }
    else {
        return { error: `Invalid BuyerType: ${buyerTypeRaw}` };
    }
    const orderDate = parseDate(orderDateRaw);
    if (!orderDate) {
        return { error: `Invalid OrderDate: ${orderDateRaw}` };
    }
    const deliveryDate = parseDate(deliveryDateRaw ?? undefined);
    const quantity = quantityRaw;
    const hasInvoice = hasInvoiceRaw ? parseBoolean(hasInvoiceRaw) : !!invoiceNumber;
    const data = {
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
//# sourceMappingURL=orderCsvMapper.js.map