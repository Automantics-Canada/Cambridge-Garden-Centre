/**
 * Base URL for the API, and for resolving relative document URLs.
 *
 * Five call sites hard-coded `https://cambridge-garden-centre-1.onrender.com`
 * as a fallback. That host is not the live backend — the API runs on Railway —
 * so whenever `VITE_API_URL` was missing the app pointed at a stale deployment
 * and silently served whatever it still had, or nothing.
 *
 * There is no fallback here on purpose. A missing `VITE_API_URL` is a broken
 * build, and it should look broken immediately rather than half-work against
 * the wrong origin.
 */
export const API_BASE_URL = import.meta.env.VITE_API_URL
  || (import.meta.env.DEV ? 'http://localhost:4000' : '');

if (!API_BASE_URL && import.meta.env.PROD) {
  console.error('VITE_API_URL is not set. API requests and document URLs will not resolve.');
}

/**
 * Absolute URL for a stored document.
 *
 * Storage returns absolute URLs for anything in Supabase; the relative form is
 * the legacy `/uploads/...` path served by the backend itself.
 */
export function resolveDocumentUrl(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `${API_BASE_URL}${url}`;
}

export function isPdfDocumentUrl(url) {
  if (!url) return false;
  try {
    return new URL(resolveDocumentUrl(url), 'http://local.invalid')
      .pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return String(url).split(/[?#]/, 1)[0].toLowerCase().endsWith('.pdf');
  }
}
