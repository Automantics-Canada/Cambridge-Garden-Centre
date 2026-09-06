import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * Returns only a short Git SHA. Invalid or absent build metadata is never
 * echoed back from a public endpoint.
 */
export function shortCommit(value: string | undefined): string {
  const commit = value?.trim();
  return commit && COMMIT_PATTERN.test(commit)
    ? commit.slice(0, 7).toLowerCase()
    : 'unknown';
}

/**
 * TypeScript creates this JavaScript module during `npm run build`, so its
 * modification time is the build time without needing another Railway
 * variable. The fallback is captured once at process start for tsx/dev runs.
 */
function buildTimestamp(moduleUrl = import.meta.url): string {
  try {
    return statSync(fileURLToPath(moduleUrl)).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

export const buildInfo = Object.freeze({
  commit: shortCommit(process.env.RAILWAY_GIT_COMMIT_SHA),
  builtAt: buildTimestamp(),
});
