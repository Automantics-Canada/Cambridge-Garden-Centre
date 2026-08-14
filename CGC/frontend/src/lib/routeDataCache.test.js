import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRouteDataCache,
  isRouteDataStale,
  loadRouteData,
  readRouteDataCache,
  readStaleRouteDataCache,
  writeRouteDataCache,
} from './routeDataCache';

describe('authenticated route data cache', () => {
  beforeEach(() => {
    sessionStorage.clear();
    clearRouteDataCache('user-a');
    clearRouteDataCache('user-b');
  });

  it('scopes cached business data to the signed-in user', () => {
    writeRouteDataCache('user-a', 'dashboard', { count: 3 });
    expect(readRouteDataCache('user-a', 'dashboard')).toEqual({ count: 3 });
    expect(readRouteDataCache('user-b', 'dashboard')).toBeNull();
  });

  it('deduplicates identical in-flight reads', async () => {
    let resolveRequest;
    const loader = vi.fn(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const first = loadRouteData('user-a', 'tickets', loader, { force: true });
    const second = loadRouteData('user-a', 'tickets', loader, { force: true });

    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(1);
    resolveRequest({ rows: [1] });
    await expect(first).resolves.toEqual({ rows: [1] });
    await expect(second).resolves.toEqual({ rows: [1] });
  });

  it('expires entries instead of serving stale data indefinitely', () => {
    writeRouteDataCache('user-a', 'dashboard', { count: 3 }, 1);
    const later = Date.now() + 10;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    expect(readRouteDataCache('user-a', 'dashboard')).toBeNull();
    vi.restoreAllMocks();
  });

  it('keeps an expired entry readable while it is being revalidated', () => {
    // The screens render this on mount so a refresh shows the previous rows
    // rather than dropping the whole table back to a skeleton.
    writeRouteDataCache('user-a', 'invoices:page=1', { rows: [1, 2] }, 1);
    const justExpired = Date.now() + 10;
    vi.spyOn(Date, 'now').mockReturnValue(justExpired);

    expect(readRouteDataCache('user-a', 'invoices:page=1')).toBeNull();
    expect(readStaleRouteDataCache('user-a', 'invoices:page=1')).toEqual({ rows: [1, 2] });
    expect(isRouteDataStale('user-a', 'invoices:page=1')).toBe(true);
    vi.restoreAllMocks();
  });

  it('stops serving a stale entry once the stale window closes', () => {
    writeRouteDataCache('user-a', 'dashboard', { count: 3 }, 1);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000);
    expect(readStaleRouteDataCache('user-a', 'dashboard')).toBeNull();
    vi.restoreAllMocks();
  });

  it('does not leak a stale entry across users', () => {
    writeRouteDataCache('user-a', 'dashboard', { count: 3 }, 1);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10);
    expect(readStaleRouteDataCache('user-b', 'dashboard')).toBeNull();
    vi.restoreAllMocks();
  });

  it('drops stale entries on logout too', () => {
    writeRouteDataCache('user-a', 'dashboard', { count: 3 }, 1);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10);
    clearRouteDataCache('user-a');
    expect(readStaleRouteDataCache('user-a', 'dashboard')).toBeNull();
    vi.restoreAllMocks();
  });

  it('does not repopulate a cleared user cache from an old request', async () => {
    let resolveRequest;
    const pending = loadRouteData(
      'user-a',
      'dashboard',
      () => new Promise((resolve) => { resolveRequest = resolve; }),
      { force: true },
    );
    await Promise.resolve();
    clearRouteDataCache('user-a');
    resolveRequest({ count: 9 });
    await pending;
    expect(readRouteDataCache('user-a', 'dashboard')).toBeNull();
  });
});
