/**
 * Ticket thumbnail generation.
 *
 * Proof-of-delivery photos arrive straight from phone cameras — a sample from
 * production is 615 KB at 1800x2391 — and the tickets list renders them into a
 * 48 CSS px box. Every list load therefore downloaded tens of megabytes to
 * display postage stamps. Supabase's render/transform endpoint returns 403 on
 * the current plan, so the resize happens here instead.
 *
 * The original is never modified or replaced. This produces an additional,
 * smaller object; `Ticket.imageUrl` continues to point at the untouched
 * upload, which is both the OCR input and the retained delivery record.
 */
import sharp from 'sharp';
import type { Sharp, Metadata } from 'sharp';

export const THUMBNAIL_SIZE = 128;
export const THUMBNAIL_CONTENT_TYPE = 'image/webp';

/**
 * Refuse absurd geometry before decoding. A small file can still declare
 * enormous dimensions (a "decompression bomb"), and decoding it would allocate
 * width x height x channels bytes. 40 megapixels comfortably exceeds any phone
 * camera while bounding the worst case.
 */
const MAX_INPUT_PIXELS = 40_000_000;

/** Formats we will produce a thumbnail from. PDFs are rasterised upstream. */
const SUPPORTED_INPUT_FORMATS = new Set(['jpeg', 'jpg', 'png', 'webp', 'gif', 'tiff', 'heif', 'avif']);

export class ThumbnailError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ThumbnailError';
  }
}

export interface ThumbnailResult {
  buffer: Buffer;
  width: number;
  height: number;
  bytes: number;
  sourceFormat: string;
  sourceBytes: number;
}

/**
 * Produce a square WebP thumbnail.
 *
 * - `rotate()` with no argument applies the EXIF orientation tag and then drops
 *   it, so a photo taken sideways is stored upright rather than appearing
 *   rotated in browsers that ignore EXIF.
 * - sharp discards metadata unless `withMetadata()` is called, so EXIF — which
 *   on a phone photo includes GPS coordinates — never reaches the thumbnail.
 * - `fit: 'cover'` matches the CSS `object-cover` the list already applies, so
 *   the thumbnail crops the same way the full image did.
 *
 * Throws ThumbnailError for unusable input. Callers must treat that as
 * non-fatal: a ticket without a thumbnail is degraded, a lost POD image is not
 * recoverable.
 */
export async function generateThumbnail(source: Buffer): Promise<ThumbnailResult> {
  if (!source || source.length === 0) {
    throw new ThumbnailError('Cannot generate a thumbnail from an empty buffer');
  }

  let pipeline: Sharp;
  let metadata: Metadata;

  try {
    pipeline = sharp(source, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });
    metadata = await pipeline.metadata();
  } catch (error) {
    throw new ThumbnailError('Source image could not be decoded', error);
  }

  const format = (metadata.format || '').toLowerCase();
  if (!SUPPORTED_INPUT_FORMATS.has(format)) {
    throw new ThumbnailError(`Unsupported source format "${format || 'unknown'}"`);
  }

  try {
    const buffer = await pipeline
      .rotate()
      .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'cover', position: 'centre' })
      .webp({ quality: 72, effort: 4 })
      .toBuffer();

    return {
      buffer,
      width: THUMBNAIL_SIZE,
      height: THUMBNAIL_SIZE,
      bytes: buffer.length,
      sourceFormat: format,
      sourceBytes: source.length,
    };
  } catch (error) {
    throw new ThumbnailError('Thumbnail encoding failed', error);
  }
}

/**
 * Storage key for the thumbnail of a given original.
 *
 * Derived purely from the original's path, which makes it deterministic: the
 * upload path and the backfill compute the same key for the same object, so
 * re-running either overwrites rather than duplicating. The original path
 * already carries a uuid and a timestamp, so the derived key inherits that
 * versioning and is safe to serve with a long-lived immutable cache header.
 *
 *   tickets/<uuid>/<uuid>-<ts>.png  ->  ticket-thumbnails/<uuid>/<uuid>-<ts>.webp
 */
export function deriveThumbnailPath(originalPath: string): string {
  const normalised = String(originalPath || '').replace(/^\/+/, '');
  if (!normalised) {
    throw new ThumbnailError('Cannot derive a thumbnail path from an empty original path');
  }

  const withoutPrefix = normalised.startsWith('tickets/')
    ? normalised.slice('tickets/'.length)
    : normalised;

  const lastDot = withoutPrefix.lastIndexOf('.');
  const stem = lastDot > 0 ? withoutPrefix.slice(0, lastDot) : withoutPrefix;

  return `ticket-thumbnails/${stem}.webp`;
}

/**
 * Recover the in-bucket object path from a stored public URL.
 *
 * Returns null when the URL is not a public storage object URL, which the
 * backfill treats as "cannot process" rather than guessing.
 */
export function storagePathFromPublicUrl(publicUrl: string, bucket: string): string | null {
  const marker = `/storage/v1/object/public/${bucket}/`;
  const index = String(publicUrl || '').indexOf(marker);
  if (index === -1) return null;
  const path = publicUrl.slice(index + marker.length).split('?')[0];
  return path ? decodeURIComponent(path) : null;
}
