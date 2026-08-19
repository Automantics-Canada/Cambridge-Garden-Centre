/** Formats incomplete legacy order quantities without turning missing data into zero. */
export function formatQuantity(quantity: unknown, unit: string | null | undefined): string {
  if (quantity === null || quantity === undefined || quantity === '') return 'Not recorded';
  const numeric = Number(quantity);
  if (!Number.isFinite(numeric)) return 'Not recorded';
  return unit ? `${numeric} ${unit}` : String(numeric);
}
