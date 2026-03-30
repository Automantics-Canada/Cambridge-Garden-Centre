import type { Prisma } from '@prisma/client';
export type RawOrderCsvRow = Record<string, string>;
export interface ParsedOrderRow {
    data?: Prisma.OrderUncheckedCreateInput;
    error?: string;
}
export declare function mapCsvRowToOrder(row: RawOrderCsvRow): ParsedOrderRow;
//# sourceMappingURL=orderCsvMapper.d.ts.map