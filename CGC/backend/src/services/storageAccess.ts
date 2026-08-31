import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { env } from '../config/env.js';

const STORAGE_SCHEME = 'storage:';
const LINK_TTL_SECONDS = 60 * 60;
const MAX_CLOCK_SKEW_SECONDS = 60;

export interface StoredObjectLocation {
  bucket: string;
  path: string;
}

function validObjectPath(value: string): boolean {
  if (!value || value.length > 1024 || value.startsWith('/') || value.includes('\\')) return false;
  const segments = value.split('/');
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

function acceptedLocation(bucket: string, objectPath: string): StoredObjectLocation | null {
  let decodedPath: string;
  try {
    decodedPath = objectPath
      .split('/')
      .map(segment => decodeURIComponent(segment))
      .join('/');
  } catch {
    return null;
  }
  if (bucket !== env.supabaseStorageBucket || !validObjectPath(decodedPath)) return null;
  return { bucket, path: decodedPath };
}

/** A durable database reference. It contains no public or expiring URL. */
export function toStorageReference(objectPath: string): string {
  if (!validObjectPath(objectPath)) throw new Error('Invalid storage object path');
  const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
  return `${STORAGE_SCHEME}//${encodeURIComponent(env.supabaseStorageBucket)}/${encodedPath}`;
}

/**
 * Accept current private references and legacy public Supabase URLs. Legacy
 * support lets the forward migration and application roll out independently.
 */
export function parseStoredObjectLocation(value: unknown): StoredObjectLocation | null {
  if (typeof value !== 'string' || value.length === 0) return null;

  if (value.startsWith(`${STORAGE_SCHEME}//`)) {
    try {
      const remainder = value.slice(`${STORAGE_SCHEME}//`.length);
      const slash = remainder.indexOf('/');
      if (slash <= 0) return null;
      return acceptedLocation(
        decodeURIComponent(remainder.slice(0, slash)),
        remainder.slice(slash + 1),
      );
    } catch {
      return null;
    }
  }

  try {
    const parsed = new URL(value);
    const configured = new URL(env.supabaseUrl);
    if (parsed.protocol !== 'https:' || parsed.origin !== configured.origin) return null;
    const prefix = '/storage/v1/object/public/';
    if (!parsed.pathname.startsWith(prefix)) return null;
    const remainder = parsed.pathname.slice(prefix.length);
    const slash = remainder.indexOf('/');
    if (slash <= 0) return null;
    return acceptedLocation(decodeURIComponent(remainder.slice(0, slash)), remainder.slice(slash + 1));
  } catch {
    return null;
  }
}

function signatureFor(encodedReference: string, expires: number): string {
  return createHmac('sha256', env.internalSharedSecret)
    .update(`${encodedReference}.${expires}`)
    .digest('base64url');
}

/** Short-lived backend proxy URL suitable for img/iframe elements. */
export function signedStorageProxyUrl(reference: string, now = Date.now()): string | null {
  const location = parseStoredObjectLocation(reference);
  if (!location) return null;
  const encoded = Buffer.from(`${location.bucket}\n${location.path}`, 'utf8').toString('base64url');
  const expires = Math.floor(now / 1000) + LINK_TTL_SECONDS;
  const signature = signatureFor(encoded, expires);
  const filename = encodeURIComponent(path.posix.basename(location.path));
  return `/api/storage/object/${encoded}/${filename}?expires=${expires}&signature=${signature}`;
}

export function verifySignedStorageRequest(
  encodedReference: unknown,
  expiresValue: unknown,
  signatureValue: unknown,
  now = Date.now(),
): StoredObjectLocation | null {
  if (typeof encodedReference !== 'string'
      || typeof expiresValue !== 'string'
      || typeof signatureValue !== 'string') return null;

  const expires = Number(expiresValue);
  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isSafeInteger(expires)
      || expires < nowSeconds
      || expires > nowSeconds + LINK_TTL_SECONDS + MAX_CLOCK_SKEW_SECONDS) return null;

  const expected = Buffer.from(signatureFor(encodedReference, expires));
  const supplied = Buffer.from(signatureValue);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;

  try {
    const decoded = Buffer.from(encodedReference, 'base64url').toString('utf8');
    const newline = decoded.indexOf('\n');
    if (newline <= 0) return null;
    return acceptedLocation(decoded.slice(0, newline), decoded.slice(newline + 1));
  } catch {
    return null;
  }
}

/** Mutates only plain response objects, preserving Date/Decimal instances. */
export function rewriteStoredDocumentUrls<T>(value: T): T {
  if (typeof value === 'string') {
    return (signedStorageProxyUrl(value) ?? value) as T;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      value[index] = rewriteStoredDocumentUrls(entry);
    });
    return value;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    return value;
  }
  for (const [key, entry] of Object.entries(value)) {
    (value as Record<string, unknown>)[key] = rewriteStoredDocumentUrls(entry);
  }
  return value;
}
