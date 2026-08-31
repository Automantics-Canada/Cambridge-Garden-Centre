import { resolveDocumentUrl } from '../lib/apiBase';

/**
 * Resolving ticket image URLs.
 *
 * Tickets have two images: `imageUrl` — the untouched proof-of-delivery upload,
 * used wherever the operator needs to actually read the ticket — and
 * `thumbnailUrl`, a small derived WebP used anywhere it is rendered at postage
 * stamp size.
 *
 * `thumbnailUrl` is nullable by design. Generation is best-effort so it can
 * never block a driver's upload, and rows predating the feature have not been
 * backfilled yet. Every caller therefore falls back to the original.
 */

function absolute(url) {
  if (!url) return null;
  return resolveDocumentUrl(url);
}

/**
 * Source for a small rendering of a ticket.
 * Prefers the thumbnail, falls back to the original, null when neither exists
 * so the caller can render a placeholder.
 */
export function ticketThumbnailSrc(ticket) {
  return absolute(ticket?.thumbnailUrl) ?? absolute(ticket?.imageUrl);
}

/**
 * Source for viewing or downloading the ticket itself.
 * Always the original — never the thumbnail, which is cropped and re-encoded
 * and is not a usable record of the delivery.
 */
export function ticketFullImageSrc(ticket) {
  return absolute(ticket?.imageUrl);
}
