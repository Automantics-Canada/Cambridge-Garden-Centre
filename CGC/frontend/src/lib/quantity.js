/** Render an incomplete legacy quantity honestly instead of turning null into 0. */
export function formatQuantity(quantity, unit) {
  if (quantity === null || quantity === undefined || quantity === '') return 'Not recorded';
  const numeric = Number(quantity);
  if (!Number.isFinite(numeric)) return 'Not recorded';
  return unit ? `${numeric} ${unit}` : String(numeric);
}

export default formatQuantity;
