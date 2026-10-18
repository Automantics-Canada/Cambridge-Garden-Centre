/** Render an incomplete legacy quantity honestly instead of turning null into 0. */
export function formatQuantity(quantity, unit) {
  if (quantity === null || quantity === undefined || quantity === '') return 'Not recorded';
  const numeric = Number(quantity);
  if (!Number.isFinite(numeric)) return 'Not recorded';
  return unit ? `${numeric} ${unit}` : String(numeric);
}

/**
 * An order's quantity: every unit's total where its products are in more than
 * one, "2.5 CY + 4 EA", else the one total. Orders sent before the server
 * listed every unit fall back to the single quantity they carry.
 */
export function formatOrderQuantity(order) {
  const totals = order?.quantities;
  if (Array.isArray(totals) && totals.length > 1) {
    return totals.map(({ quantity, unit }) => formatQuantity(quantity, unit)).join(' + ');
  }
  return formatQuantity(order?.quantity, order?.unit);
}

export default formatQuantity;
