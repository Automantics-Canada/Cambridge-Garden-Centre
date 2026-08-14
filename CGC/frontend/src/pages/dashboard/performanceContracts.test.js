import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dashboardSource = readFileSync(resolve('src/pages/dashboard/Dashboard.jsx'), 'utf8');
const verificationDeskSource = readFileSync(resolve('src/pages/dashboard/VerificationDesk.jsx'), 'utf8');

describe('authenticated route performance contracts', () => {
  it('keeps Dashboard on bounded endpoints supported by the live Edge function', () => {
    expect(dashboardSource).not.toMatch(
      /\.invoke\(['"]fetch-cgc-data\?resource=dashboard-summary/,
    );
    expect(dashboardSource).toContain('resource=invoices&limit=5&page=1');
    expect(dashboardSource).toContain('status=PENDING_REVIEW&limit=1&page=1');
    expect(dashboardSource).toContain('status=DISPUTED&limit=1&page=1');
  });

  it('keeps Verification Desk paginated and invoice details lazy', () => {
    expect(verificationDeskSource).toContain('const INVOICES_PER_PAGE = 25');
    expect(verificationDeskSource).not.toContain('limit=1000');
    expect(verificationDeskSource).not.toMatch(/fetchInvoiceDetails\(firstId\)/);
    expect(verificationDeskSource).toContain("params.set('status', filterStatus)");
    expect(verificationDeskSource).toContain("params.set('search', debouncedSearch)");
  });
});
