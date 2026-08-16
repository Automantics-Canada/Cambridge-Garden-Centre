/**
 * One normalisation for product wording, shared by everything that compares it.
 *
 * Aliases are stored normalised and looked up normalised. If the writer and the
 * reader normalised differently — even by one character — every alias would
 * silently miss and the system would fall back to fuzzy matching without
 * anyone being told. Both sides call this.
 */
export function normalizeProductName(str: string): string {
  return str
    .toLowerCase()
    .replace(/type\s+/g, '')
    .replace(/[^a-z0-9\s]/g, ' ') // hyphens and slashes become separators, not deletions
    .replace(/\s+/g, ' ')
    .trim();
}
