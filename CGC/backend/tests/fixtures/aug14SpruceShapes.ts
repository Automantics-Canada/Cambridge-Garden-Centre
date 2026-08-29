import type {
  ParsedSpruceReport,
  ParsedSpruceRow,
  SpruceReportType,
} from '../../src/modules/orders/spruce/spruceReportTypes.js';

/**
 * Structural copy of the three Aug-14 reports, with all client values replaced
 * by stable synthetic tokens. Report order, row/document counts, repeated
 * identities, cross-report equality, optional-field presence, and overlap are
 * preserved; no client names, document numbers, addresses, products, POs,
 * vendors, dates, or quantities are stored in Git.
 */
const REPORT_SHAPES: Record<SpruceReportType, string> = {
  ORDER_SUMMARY: `
D01 C01 I01 P01 Q01 CY - - - -
D02 C02 I02 P02 Q02 - - - - -
D02 C02 I03 P03 Q03 EA - - - -
D02 C02 I04 P04 Q02 EA - - - -
D02 C02 I05 P05 Q02 EA - - - -
D02 C02 I06 P06 Q04 EA - - - -
D02 C02 I05 P05 Q02 EA - - - -
D02 C02 I07 P07 Q02 EA - - - -
D03 C03 I08 P08 Q05 SQFT - - - -
D03 C03 I02 P09 Q02 - - - - -
D03 C03 I09 P10 Q03 EA - - - -
D04 C04 I10 P11 Q06 SQFT T1 - - -
D04 C04 I11 P12 Q07 EA T1 - - -
D04 C04 I12 P13 Q08 SQFT T1 - - -
D04 C04 I11 P12 Q02 EA T1 - - -
D04 C04 I13 P14 Q02 EA T1 - - -
D04 C04 I02 P15 Q02 - T1 - - -
D05 C05 I01 P01 Q03 CY - - - -
D06 C06 I14 P16 Q09 MT T2 - - -
D06 C06 I15 P17 Q09 MT T2 - - -
D07 C07 I16 P18 Q10 CY T3 - - -
D07 C07 I17 P19 Q02 EA T3 - - -
D08 C08 I18 P20 Q11 MT T2 - - -
D09 C09 I19 P21 Q02 EA T4 - - -
D10 C10 I20 P22 Q02 EA T2 - - -
D10 C10 I21 P23 Q03 EA T2 - - -
D11 C08 I02 P24 Q02 - - - - -
D11 C08 I19 P25 Q10 EA - - - -
D11 C08 I22 P26 Q10 EA - - - -
D11 C08 I19 P27 Q07 EA - - - -
D11 C08 I22 P26 Q07 EA - - - -
D11 C08 I19 P28 Q12 EA - - - -
D12 C11 I23 P29 Q02 CY T2 - - -
D12 C11 I24 P30 Q02 HCY T2 - - -
D12 C11 I25 P31 Q02 CY T2 - - -
D12 C11 I26 P32 Q02 EA T2 - - -
`,
  ITEM_TRACKING: `
D01 C01 I01 P01 Q01 - - - - A01
D02 C02 I04 P04 Q02 - - - - A02
D02 C02 I03 P03 Q03 - - - - A02
D02 C02 I05 P05 Q02 - - - - A02
D02 C02 I05 P05 Q02 - - - - A02
D02 C02 I06 P06 Q04 - - - - A02
D02 C02 I02 P02 Q02 - - - - A02
D02 C02 I07 P07 Q02 - - - - A02
D03 C03 I02 P09 Q02 - - PO01 V01 A03
D03 C03 I08 P08 Q05 - - PO01 V01 A03
D03 C03 I09 P10 Q03 - - PO01 V01 A03
D04 C04 I12 P13 Q08 - T1 PO02 V02 A04
D04 C04 I10 P11 Q06 - T1 PO02 V02 A04
D04 C04 I02 P15 Q02 - T1 PO02 V02 A04
D04 C04 I13 P14 Q02 - T1 PO02 V02 A04
D04 C04 I11 P12 Q02 - T1 PO02 V02 A04
D04 C04 I11 P12 Q07 - T1 PO02 V02 A04
D05 C05 I01 P01 Q03 - - - - A05
D13 C09 I27 P33 Q02 - - - - A06
D06 CASH I14 P16 Q09 - T2 - - A07
D06 CASH I15 P17 Q09 - T2 - - A07
D07 CASH I16 P18 Q10 - T3 - - A08
D07 CASH I17 P19 Q02 - T3 - - A08
D08 C08 I18 P20 Q11 - T2 - - A09
D09 C09 I19 P21 Q02 - T4 - - A10
D10 CASH I20 P22 Q02 - T2 - - A11
D10 CASH I21 P23 Q03 - T2 - - A11
D11 C08 I02 P24 Q02 - - - - -
D11 C08 I19 P25 Q10 - - - - -
D11 C08 I19 P28 Q12 - - - - -
D11 C08 I19 P27 Q07 - - - - -
D11 C08 I22 P26 Q07 - - - - -
D11 C08 I22 P26 Q10 - - - - -
D12 CASH I23 P29 Q02 - T2 - - A12
D12 CASH I24 P30 Q02 - T2 - - A12
D12 CASH I25 P31 Q02 - T2 - - A12
D12 CASH I26 P32 Q02 - T2 - - A12
`,
  DELIVERY: `
D14 C12 I28 P34 Q10 CY - - - -
D14 C12 I29 P35 Q02 EA - - - -
D15 C13 I30 P36 Q13 SQFT - - - -
D15 C13 I09 P10 Q03 EA - - - -
D15 C13 I13 P14 Q02 EA - - - -
D16 C14 I31 P37 Q09 CY - - - -
D16 C14 I32 P38 Q02 EA - - - -
D16 C14 I33 P39 Q03 BAG - - - -
D17 C15 I34 P40 Q14 SQFT - - - -
D17 C15 I02 P41 Q02 - - - - -
D17 C15 I35 P42 Q02 EA - - - -
D17 C15 I36 P43 Q15 SQFT - - - -
D17 C15 I02 P44 Q02 - - - - -
D17 C15 I35 P42 Q03 EA - - - -
D17 C15 I37 P45 Q02 HR - - - -
D18 C16 I38 P46 Q02 CYBG - - - -
D19 C17 I39 P47 Q10 CY - - - -
D19 C17 I40 P48 Q02 HCY - - - -
D19 C17 I41 P49 Q02 EA - - - -
D20 C18 I42 P50 Q16 MT - - - -
D20 C18 I42 P50 Q16 MT - - - -
D20 C18 I42 P50 Q16 MT - - - -
D20 C18 I42 P50 Q16 MT - - - -
D20 C18 I42 P50 Q16 MT - - - -
D20 C18 I42 P50 Q16 MT - - - -
D21 C19 I01 P01 Q17 CYDL - - - -
D22 C20 I43 P51 Q02 EA - - - -
D22 C20 I28 P34 Q17 CY - - - -
D23 C21 I39 P47 Q02 CY - - - -
D23 C21 I44 P52 Q02 EA - - - -
D24 C22 I45 P53 Q09 MT - - - -
D25 C23 I14 P16 Q18 MT - - - -
D06 C06 I14 P16 Q09 MT - - - -
D06 C06 I15 P17 Q09 MT - - - -
D08 C08 I18 P20 Q11 MT - - - -
D10 C10 I20 P22 Q02 EA - - - -
D10 C10 I21 P23 Q03 EA - - - -
D12 C11 I26 P32 Q02 EA - - - -
D12 C11 I23 P29 Q02 CY - - - -
D12 C11 I24 P30 Q02 HCY - - - -
D12 C11 I25 P31 Q02 CY - - - -
`,
};

const DELIVERY_DATES: Record<string, string> = {
  T1: '09/01/2026',
  T2: '09/02/2026',
  T3: '09/03/2026',
  T4: '09/04/2026',
};

function syntheticDocument(token: string): string {
  return `9900-${token.slice(1).padStart(6, '0')}`;
}

function parseShape(type: SpruceReportType, shape: string): ParsedSpruceReport {
  const rows: ParsedSpruceRow[] = shape.trim().split('\n').map((line, index) => {
    const [
      document,
      customer,
      item,
      product,
      quantity,
      unit,
      deliveryDate,
      po,
      vendor,
      address,
    ] = line.trim().split(/\s+/);

    if (
      !document || !customer || !item || !product || !quantity || !unit ||
      !deliveryDate || !po || !vendor || !address
    ) {
      throw new Error(`Invalid synthetic Spruce shape at ${type} row ${index + 1}`);
    }
    const resolvedDeliveryDate = deliveryDate === '-'
      ? undefined
      : DELIVERY_DATES[deliveryDate];
    if (deliveryDate !== '-' && !resolvedDeliveryDate) {
      throw new Error(`Invalid synthetic delivery date at ${type} row ${index + 1}`);
    }

    return {
      documentNumber: syntheticDocument(document),
      customerName: customer === 'CASH' ? 'Cash Sales' : `Synthetic Customer ${customer}`,
      product: `Synthetic Product ${product}`,
      itemNumber: `ITEM-${item}`,
      quantity: Number(quantity.slice(1)),
      ...(unit !== '-' ? { unit } : {}),
      orderDateRaw: '08/14/2026',
      ...(resolvedDeliveryDate ? { deliveryDateRaw: resolvedDeliveryDate } : {}),
      ...(po !== '-' ? { poNumber: `SYN-${po}` } : {}),
      ...(vendor !== '-' ? { vendorName: `SYN-${vendor}` } : {}),
      ...(address !== '-' ? { shippingAddress: `Synthetic Address ${address}` } : {}),
      source: { page: Math.floor(index / 15) + 1, row: index + 1 },
    };
  });

  return { type, rows, unreadable: [] };
}

export function aug14SpruceReports(): Record<SpruceReportType, ParsedSpruceReport> {
  return {
    ORDER_SUMMARY: parseShape('ORDER_SUMMARY', REPORT_SHAPES.ORDER_SUMMARY),
    ITEM_TRACKING: parseShape('ITEM_TRACKING', REPORT_SHAPES.ITEM_TRACKING),
    DELIVERY: parseShape('DELIVERY', REPORT_SHAPES.DELIVERY),
  };
}
