import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endSessionOnUnauthorized } from './axios';
import { takeSessionNotice } from '../lib/session';

const originalLocation = window.location;

/** Stands in for `window.location`, recording where the app was sent. */
function stubLocation(pathname, search = '') {
  const replace = vi.fn();
  delete window.location;
  window.location = { pathname, search, replace };
  return replace;
}

function unauthorized(url) {
  return { config: { url }, response: { status: 401 } };
}

describe('ending the session on 401', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('token', 'stored-token');
    localStorage.setItem('user', JSON.stringify({ name: 'jim' }));
  });

  afterEach(() => {
    window.location = originalLocation;
  });

  it('clears the session and sends the user to sign in again', () => {
    const replace = stubLocation('/dashboard');

    endSessionOnUnauthorized(unauthorized('/api/dashboard/summary'));

    expect(localStorage.getItem('token')).toBeNull();
    expect(replace).toHaveBeenCalledWith('/login?next=%2Fdashboard');
    expect(takeSessionNotice()).toMatch(/expired/i);
  });

  it('remembers the screen the user was on, query string included', () => {
    const replace = stubLocation('/invoices', '?page=2');

    endSessionOnUnauthorized(unauthorized('/api/invoices'));

    expect(replace).toHaveBeenCalledWith('/login?next=%2Finvoices%3Fpage%3D2');
  });

  it('leaves a failed login alone so the password error stays visible', () => {
    const replace = stubLocation('/login');

    endSessionOnUnauthorized(unauthorized('/api/auth/login'));

    expect(localStorage.getItem('token')).toBe('stored-token');
    expect(replace).not.toHaveBeenCalled();
  });

  it('does not bounce the login screen back to itself', () => {
    const replace = stubLocation('/login');

    endSessionOnUnauthorized(unauthorized('/api/dashboard/summary'));

    expect(localStorage.getItem('token')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('leaves other failures to the screen that made the request', () => {
    const replace = stubLocation('/dashboard');

    endSessionOnUnauthorized({ config: { url: '/api/dashboard/summary' }, response: { status: 500 } });
    endSessionOnUnauthorized({ config: { url: '/api/dashboard/summary' } });

    expect(localStorage.getItem('token')).toBe('stored-token');
    expect(replace).not.toHaveBeenCalled();
  });
});
