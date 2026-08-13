/**
 * Bounded, content-checked file uploads.
 *
 * Before this module the upload routes accepted any declared content type at
 * whatever size multer happened to be configured with — and the delivery photo
 * route had no size limit at all. Every upload path feeds either Supabase
 * Storage or a paid OCR pipeline, so unvalidated input is both a storage and a
 * cost-abuse problem.
 *
 * Three layers, cheapest first:
 *   1. `limits.fileSize` — busboy stops reading once the cap is passed, so an
 *      oversized body is never fully buffered.
 *   2. `fileFilter` — runs on the part header, before the body is buffered, and
 *      rejects a disallowed declared MIME type or file extension.
 *   3. `validateUploadContent` — magic-byte check on the received buffer, which
 *      is the only layer a client cannot lie to. It necessarily runs after
 *      buffering, but the buffer is already bounded by layer 1.
 *
 * SVG is deliberately absent from the image set: it is script-bearing markup and
 * these files are served back to browsers from storage.
 */
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import path from 'node:path';

export type UploadKind = 'image' | 'pdf';

interface FileSignature {
  kind: UploadKind;
  label: string;
  matches: (buffer: Buffer) => boolean;
}

const HEIF_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1',
]);

const SIGNATURES: FileSignature[] = [
  {
    kind: 'image',
    label: 'PNG',
    matches: (b) => b.length >= 8 && b.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    ),
  },
  {
    kind: 'image',
    label: 'JPEG',
    matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    kind: 'image',
    label: 'GIF',
    matches: (b) => b.length >= 6 &&
      (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a'),
  },
  {
    kind: 'image',
    label: 'WebP',
    matches: (b) => b.length >= 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
  {
    // Phone cameras still produce HEIC/HEIF. The driver proof-of-delivery input
    // is `accept="image/*" capture="environment"`, so rejecting it here would
    // break a live workflow on iOS.
    kind: 'image',
    label: 'HEIF/HEIC',
    matches: (b) => b.length >= 12 &&
      b.toString('ascii', 4, 8) === 'ftyp' && HEIF_BRANDS.has(b.toString('ascii', 8, 12)),
  },
  {
    kind: 'pdf',
    label: 'PDF',
    matches: (b) => b.length >= 5 && b.toString('ascii', 0, 5) === '%PDF-',
  },
];

const ALLOWED_MIME: Record<UploadKind, readonly string[]> = {
  image: ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/heic', 'image/heif'],
  pdf: ['application/pdf'],
};

const ALLOWED_EXT: Record<UploadKind, readonly string[]> = {
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif'],
  pdf: ['.pdf'],
};

/** Detect the real type from the leading bytes, ignoring what the client claimed. */
export function detectFileKind(buffer: Buffer): { kind: UploadKind; label: string } | null {
  for (const signature of SIGNATURES) {
    if (signature.matches(buffer)) {
      return { kind: signature.kind, label: signature.label };
    }
  }
  return null;
}

/**
 * Reduce an uploaded name to a safe basename.
 *
 * Strips any directory component (including Windows-style separators, which
 * `path.basename` leaves alone on POSIX hosts), control characters and leading
 * dots, then bounds the length. Never returns an empty string.
 */
export function sanitizeFilename(originalName: string): string {
  const withoutDirs = String(originalName ?? '').replace(/[\\/]+/g, '/').split('/').pop() ?? '';
  const cleaned = withoutDirs
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'upload';
}

export interface UploaderOptions {
  maxBytes: number;
  kinds: readonly UploadKind[];
}

/** multer instance bounded by size and filtered by declared type + extension. */
export function createUploader({ maxBytes, kinds }: UploaderOptions) {
  const mimes = new Set(kinds.flatMap((kind) => ALLOWED_MIME[kind]));
  const exts = new Set(kinds.flatMap((kind) => ALLOWED_EXT[kind]));

  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1 },
    fileFilter: (_req, file, cb) => {
      const declared = (file.mimetype || '').toLowerCase();
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (!mimes.has(declared)) {
        return cb(new UploadValidationError(`Unsupported content type "${declared}"`));
      }
      if (ext && !exts.has(ext)) {
        return cb(new UploadValidationError(`Unsupported file extension "${ext}"`));
      }
      cb(null, true);
    },
  });
}

export class UploadValidationError extends Error {
  status = 415;
  constructor(message: string) {
    super(message);
    this.name = 'UploadValidationError';
  }
}

/**
 * Express middleware asserting the received bytes really are one of `kinds`.
 * Place it directly after the multer middleware on the route.
 */
export function validateUploadContent(kinds: readonly UploadKind[], required = true) {
  const allowed = new Set(kinds);
  return (req: Request, res: Response, next: NextFunction) => {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      if (required) {
        return res.status(400).json({ error: 'File is required' });
      }
      return next();
    }

    const detected = detectFileKind(file.buffer);
    if (!detected || !allowed.has(detected.kind)) {
      return res.status(415).json({
        error: `File content is not an accepted ${[...allowed].join(' or ')} format`,
      });
    }

    file.originalname = sanitizeFilename(file.originalname);
    next();
  };
}

/**
 * Turns multer/limit failures into useful status codes instead of a generic 500.
 * Mount after the routes that use `createUploader`.
 */
export function uploadErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
) {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: err.message });
  }
  if (err instanceof UploadValidationError) {
    return res.status(err.status).json({ error: err.message });
  }
  return next(err);
}
