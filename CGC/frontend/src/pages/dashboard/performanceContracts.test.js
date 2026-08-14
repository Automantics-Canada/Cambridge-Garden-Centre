import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(resolve(p), 'utf8');
/** Comments describe the removed behaviour, so guards must scan code only. */
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const dashboardSource = read('src/pages/dashboard/Dashboard.jsx');
const verificationDeskSource = read('src/pages/dashboard/VerificationDesk.jsx');
const invoicesPageSource = read('src/pages/dashboard/InvoicesPage.jsx');
const dashboardLayoutSource = read('src/layouts/DashboardLayout.jsx');
const routeDataSource = read('src/data/routeData.js');
const cacheSource = read('src/lib/routeDataCache.js');

describe('authenticated route performance contracts', () => {
  it('reads each resource from exactly one source', () => {
    // The previous revision raced the Express API, the Supabase Edge function
    // and the legacy full-ledger endpoint, then took the first to resolve. In
    // production that made the tickets screen issue seven requests for three
    // pieces of data, and neither losing branch was ever a healthy fallback:
    // /api/suppliers/options answered 404 and the Edge dashboard-summary 400.
    const code = codeOnly(routeDataSource);
    expect(code).not.toContain('Promise.any');
    expect(code).not.toContain('supabase.functions.invoke');
    expect(code).not.toContain('fetch-cgc-data');
    expect(code).toContain("'/api/invoices/dashboard-summary'");
    expect(code).toContain("'/api/suppliers/options'");
  });

  it('never asks any endpoint for an unbounded page', () => {
    for (const source of [routeDataSource, verificationDeskSource, invoicesPageSource]) {
      expect(codeOnly(source)).not.toContain('limit=1000');
    }
    expect(codeOnly(routeDataSource)).not.toMatch(/limit:\s*1000/);
  });

  it('keeps Dashboard off the unbounded invoice list', () => {
    expect(dashboardSource).toContain('loadDashboardData');
    expect(codeOnly(dashboardSource)).not.toContain("api.get('/api/invoices')");
  });

  it('keeps Verification Desk paginated on the server and details lazy', () => {
    const code = codeOnly(verificationDeskSource);
    expect(code).toContain('const INVOICES_PER_PAGE = 25');
    // The whole-ledger read: api.get('/api/invoices') with no params.
    expect(code).not.toMatch(/api\.get\(\s*'\/api\/invoices'\s*\)/);
    expect(code).toContain('loadInvoicePage');
    // Line items still arrive only when a row is opened.
    expect(code).toContain('api.get(`/api/invoices/${id}`)');
    expect(code).not.toContain('supabase.functions.invoke');
  });

  it('resets Verification Desk pagination before a changed filter can request the old page', () => {
    const code = codeOnly(verificationDeskSource);
    const reset = code.indexOf('const filterSignature = JSON.stringify([filterStatus, debouncedSearch])');
    const query = code.indexOf('const query = useMemo');
    expect(reset).toBeGreaterThan(-1);
    expect(code.slice(reset, query)).toContain('setPage(1)');
    expect(reset).toBeLessThan(query);
  });

  it('sends Invoices page filters to the server instead of filtering locally', () => {
    const code = codeOnly(invoicesPageSource);
    expect(code).toContain('loadInvoicePage');
    expect(code).toContain('loadSupplierOptions');
    expect(code).not.toContain('supabase.functions.invoke');
    // Counters replace the full line-item array on list rows.
    expect(code).toContain('inv.flaggedCount');
    expect(code).toContain('inv.lineItemCount');
    expect(code).not.toMatch(/inv\.lineItems\?\.filter/);
  });

  it('surfaces load failures instead of leaving a skeleton up', () => {
    for (const source of [dashboardSource, verificationDeskSource, invoicesPageSource]) {
      expect(source).toContain('loadError');
      expect(source).toContain('role="alert"');
    }
  });

  it('keeps previously loaded rows visible while revalidating', () => {
    // A stale-tolerant read is what stops a background refresh from replacing
    // the table the user is reading with a skeleton.
    expect(cacheSource).toContain('readStaleRouteDataCache');
    expect(routeDataSource).toContain('readStaleRouteDataCache');
    expect(codeOnly(verificationDeskSource)).toContain('getCachedInvoicePage');
    expect(codeOnly(invoicesPageSource)).toContain('getCachedInvoicePage');
  });

  it('keeps the cache per-user, expiring and cleared on logout', () => {
    expect(cacheSource).toContain('inFlightRequests');
    expect(cacheSource).toContain('cacheGenerations');
    expect(cacheSource).toContain('STALE_WINDOW_MS');
    expect(cacheSource).toMatch(/storageKey\(userId, key\)/);
    expect(dashboardLayoutSource).toContain('clearRouteDataCache(user?.id)');
  });

  it('preloads dashboard route chunks without blanking the shared layout', () => {
    expect(dashboardLayoutSource).toContain('preloadDashboardRoute(item.path)');
    expect(dashboardLayoutSource).toContain('preloadAllDashboardRoutes()');
    expect(dashboardLayoutSource).toContain('preloadRouteData(item.path, userId)');
    expect(dashboardLayoutSource).toContain('<Suspense');
    expect(dashboardLayoutSource).toContain('<Outlet />');
  });

  it('the comment stripper does not hide real code', () => {
    expect(codeOnly('// Promise.any was removed\nconst a = 1;')).not.toContain('Promise.any');
    expect(codeOnly('const x = Promise.any([a]);')).toContain('Promise.any');
    expect(codeOnly("const u = 'https://x/y';")).toContain('https://x/y');
  });
});
