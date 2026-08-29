/**
 * The stored session, and the one place that decides whether it is still usable.
 *
 * Login issues a JWT that expires after seven days. The app used to treat the
 * mere presence of that string in `localStorage` as "signed in", so once it
 * expired the shell still rendered — greeting the user by name off the cached
 * user object — while every read came back 401. The screen looked like an
 * outage. It was a session that had quietly run out.
 *
 * Nothing here talks to the network: `exp` is read straight out of the token so
 * an expired session sends the user to the login form instead of into a
 * dashboard that cannot load.
 */

const TOKEN_KEY = 'token';
const USER_KEY = 'user';
const NOTICE_KEY = 'auth:notice';

/** Decodes a JWT payload. Returns null for anything that is not one. */
function decodePayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

/**
 * True when the token is unusable: malformed, or past its `exp`.
 *
 * A token with no `exp` is treated as valid — the server is still the
 * authority, and the 401 interceptor catches it if the server disagrees.
 */
export function isTokenExpired(token, now = Date.now()) {
  const payload = decodePayload(token);
  if (!payload) return true;
  if (typeof payload.exp !== 'number') return false;
  return payload.exp * 1000 <= now;
}

/** Removes the stored session. Safe to call when there is nothing stored. */
export function clearStoredSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    // Private-mode storage failures are not worth breaking a sign-out over.
  }
}

/**
 * Reads the session for the initial Redux state, dropping it if the token has
 * already expired so the app never boots into an authenticated-looking shell
 * it cannot load data for.
 */
export function readStoredSession() {
  let token = null;
  let user = null;
  try {
    token = localStorage.getItem(TOKEN_KEY);
    user = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return { token: null, user: null };
  }

  if (!token || isTokenExpired(token)) {
    if (token) {
      clearStoredSession();
      setSessionNotice('Your session expired. Please sign in again.');
    }
    return { token: null, user: null };
  }

  return { token, user };
}

/** Queues a one-shot message for the login screen to show after a bounce. */
export function setSessionNotice(message) {
  try {
    sessionStorage.setItem(NOTICE_KEY, message);
  } catch {
    // A missing notice is cosmetic; never let it break the redirect.
  }
}

/** Reads and consumes the queued login-screen message. */
export function takeSessionNotice() {
  try {
    const message = sessionStorage.getItem(NOTICE_KEY);
    if (message) sessionStorage.removeItem(NOTICE_KEY);
    return message;
  } catch {
    return null;
  }
}
