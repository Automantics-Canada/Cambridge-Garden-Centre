export function isPdfDocument(url) {
  if (!url) return false;
  try {
    return decodeURIComponent(new URL(url, 'https://document.invalid').pathname).toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}
