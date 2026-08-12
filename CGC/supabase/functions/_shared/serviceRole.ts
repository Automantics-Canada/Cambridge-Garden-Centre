/**
 * Service-role gate for Edge Functions that must never be invoked with the
 * published anon key (which is itself a valid project JWT).
 *
 * Dependency-free so Deno at the edge and the Node test suite share one
 * implementation. Fail closed: a missing expected key never authorizes.
 */

function timingSafeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a[i] ^ b[i];
  }
  return mismatch === 0;
}

/**
 * Whether `authorizationHeader` is exactly `Bearer <serviceRoleKey>`.
 * Empty or missing values are denied.
 */
export function isServiceRoleBearer(
  authorizationHeader: string | null | undefined,
  serviceRoleKey: string | null | undefined
): boolean {
  if (!authorizationHeader || !serviceRoleKey) return false;
  if (!authorizationHeader.startsWith('Bearer ')) return false;
  const token = authorizationHeader.slice('Bearer '.length);
  if (!token || !serviceRoleKey) return false;
  return timingSafeEqual(token, serviceRoleKey);
}
