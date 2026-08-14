import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dashboardSource = readFileSync(resolve('src/pages/dashboard/Dashboard.jsx'), 'utf8');
const verificationDeskSource = readFileSync(resolve('src/pages/dashboard/VerificationDesk.jsx'), 'utf8');
const dashboardLayoutSource = readFileSync(resolve('src/layouts/DashboardLayout.jsx'), 'utf8');
const routeDataSource = readFileSync(resolve('src/data/routeData.js'), 'utf8');

describe('authenticated route performance contracts', () => {
  it('keeps Dashboard off the unbounded invoice list and resilient to deployment drift', () => {
    expect(dashboardSource).toContain('loadDashboardData');
    expect(dashboardSource).not.toContain("api.get('/api/invoices')");
    expect(routeDataSource).toContain("api.get('/api/invoices/dashboard-summary'");
    expect(routeDataSource).toContain("api.get('/api/invoices'");
    expect(routeDataSource).toContain("resource: 'dashboard-summary'");
    expect(routeDataSource).toContain('Promise.any');
  });

  it('keeps Verification Desk paginated and invoice details lazy', () => {
    expect(verificationDeskSource).toContain('const INVOICES_PER_PAGE = 25');
    expect(verificationDeskSource).not.toContain('limit=1000');
    expect(verificationDeskSource).not.toMatch(/fetchInvoiceDetails\(firstId\)/);
    expect(verificationDeskSource).toContain("api.get('/api/invoices')");
    expect(verificationDeskSource).toContain('api.get(`/api/invoices/${id}`)');
    expect(verificationDeskSource).not.toContain('supabase.functions.invoke');
  });

  it('preloads dashboard route chunks without blanking the shared layout', () => {
    expect(dashboardLayoutSource).toContain('preloadDashboardRoute(item.path)');
    expect(dashboardLayoutSource).toContain('preloadAllDashboardRoutes()');
    expect(dashboardLayoutSource).toContain('preloadRouteData(item.path, userId)');
    expect(dashboardLayoutSource).toContain('<Suspense');
    expect(dashboardLayoutSource).toContain('<Outlet />');
  });
});
