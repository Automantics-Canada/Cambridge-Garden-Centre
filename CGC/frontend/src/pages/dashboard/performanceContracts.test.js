import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dashboardSource = readFileSync(resolve('src/pages/dashboard/Dashboard.jsx'), 'utf8');
const verificationDeskSource = readFileSync(resolve('src/pages/dashboard/VerificationDesk.jsx'), 'utf8');
const dashboardLayoutSource = readFileSync(resolve('src/layouts/DashboardLayout.jsx'), 'utf8');

describe('authenticated route performance contracts', () => {
  it('keeps Dashboard off the slow, deployment-drifted Edge function', () => {
    expect(dashboardSource).toContain("api.get('/api/invoices')");
    expect(dashboardSource).not.toContain('supabase.functions.invoke');
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
    expect(dashboardLayoutSource).toContain('<Suspense');
    expect(dashboardLayoutSource).toContain('<Outlet />');
  });
});
