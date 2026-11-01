/**
 * Spruce vendor codes on the Supplier page.
 *
 * Same rule as the backend (spruceVendors.service.ts): upper-case letters,
 * digits and . _ -, up to 32 characters, as Spruce prints them.
 */
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;

/** The code as Spruce prints it, or null when it cannot be one. */
export function normaliseVendorCode(raw) {
  const code = String(raw ?? '').trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

/** Active codes first, then retired ones, each alphabetical. */
export function sortVendorCodes(codes) {
  return [...(codes ?? [])].sort((a, b) => Number(b.active) - Number(a.active) || a.code.localeCompare(b.code));
}

/** "EXAMPLEV01 · 3 lines · Example Yard" for an unmapped code. */
export function describeUnmapped(entry) {
  const lines = `${entry.lineCount} ${entry.lineCount === 1 ? 'line' : 'lines'}`;
  return [entry.code, lines, entry.location].filter(Boolean).join(' · ');
}

/** What to tell the person after mapping a code. */
export function mappedMessage(result) {
  if (!result?.changed) return `${result?.code} is already mapped here.`;
  if (result.linkedLines > 0) {
    return `${result.code} mapped. ${result.linkedLines} imported ${result.linkedLines === 1 ? 'line now names' : 'lines now name'} this supplier.`;
  }
  return `${result.code} mapped.`;
}
