import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearStoredSession,
  isTokenExpired,
  readStoredSession,
  setSessionNotice,
  takeSessionNotice,
} from './session';

/** Builds a token whose `exp` is `secondsFromNow` away. Signature is not read. */
function tokenExpiringIn(secondsFromNow) {
  const payload = { id: 'u1', exp: Math.floor(Date.now() / 1000) + secondsFromNow };
  const body = btoa(JSON.stringify(payload)).replace(/=+$/, '');
  return `header.${body}.signature`;
}

describe('stored session', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('keeps a session whose token has not expired', () => {
    localStorage.setItem('token', tokenExpiringIn(3600));
    localStorage.setItem('user', JSON.stringify({ name: 'jim' }));

    expect(readStoredSession().user).toEqual({ name: 'jim' });
  });

  it('drops an expired token instead of booting into a shell that cannot load', () => {
    localStorage.setItem('token', tokenExpiringIn(-60));
    localStorage.setItem('user', JSON.stringify({ name: 'jim' }));

    expect(readStoredSession()).toEqual({ token: null, user: null });
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('user')).toBeNull();
  });

  it('explains itself on the login screen after dropping an expired token', () => {
    localStorage.setItem('token', tokenExpiringIn(-60));
    readStoredSession();

    expect(takeSessionNotice()).toMatch(/expired/i);
  });

  it('treats a token that is not a JWT as unusable', () => {
    expect(isTokenExpired('not-a-jwt')).toBe(true);
    expect(isTokenExpired(null)).toBe(true);
  });

  it('leaves a token without an expiry to the server to reject', () => {
    const body = btoa(JSON.stringify({ id: 'u1' })).replace(/=+$/, '');
    expect(isTokenExpired(`header.${body}.signature`)).toBe(false);
  });

  it('serves a notice once', () => {
    setSessionNotice('Your session expired. Please sign in again.');

    expect(takeSessionNotice()).toBe('Your session expired. Please sign in again.');
    expect(takeSessionNotice()).toBeNull();
  });

  it('clears both halves of the session', () => {
    localStorage.setItem('token', tokenExpiringIn(3600));
    localStorage.setItem('user', JSON.stringify({ name: 'jim' }));

    clearStoredSession();

    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('user')).toBeNull();
  });
});
