function pathOf(url) {
  if (!url) return '';
  try {
    return decodeURIComponent(new URL(url, 'https://document.invalid').pathname).toLowerCase();
  } catch {
    return '';
  }
}

export function isPdfDocument(url) {
  return pathOf(url).endsWith('.pdf');
}

/**
 * An Excel or CSV file (A12). A browser cannot show one, so the invoice page
 * offers it as a download instead of a broken image.
 */
export function isSpreadsheetDocument(url) {
  return /\.(xlsx|xls|csv)$/.test(pathOf(url));
}

/** "loads.xlsx · 24 KB" for a file offered as a download. */
export function describeFile(name, bytes) {
  const label = name || 'File';
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return label;
  if (bytes < 1024) return `${label} · ${bytes} B`;
  if (bytes < 1024 * 1024) return `${label} · ${Math.round(bytes / 1024)} KB`;
  return `${label} · ${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
