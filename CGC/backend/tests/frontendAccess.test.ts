/**
 * Guard against reintroducing unauthenticated PostgREST access from the SPA.
 *
 * After the public-schema lockdown, `supabase.from(...)` and
 * `postgres_changes` on the anon client either leak data (if the migration
 * is not applied) or go silent (if it is). These pages must poll authenticated
 * endpoints instead.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const frontendSrc = join(dirname(fileURLToPath(import.meta.url)), '../../frontend/src');

function readPage(relativePath: string): string {
  return readFileSync(join(frontendSrc, relativePath), 'utf8');
}

const PAGES = [
  'pages/dashboard/InvoicesPage.jsx',
  'pages/dashboard/TicketsPage.jsx',
  'pages/dispatch/DispatchBoard.jsx',
  'pages/driver/DriverMobileView.jsx',
] as const;

describe('polling replacement does not reintroduce anon table access', () => {
  for (const page of PAGES) {
    it(`${page} does not subscribe to postgres_changes`, () => {
      assert.equal(readPage(page).includes('postgres_changes'), false, page);
    });

    it(`${page} does not query tables with the anon client`, () => {
      assert.equal(readPage(page).includes('supabase.from('), false, page);
    });
  }

  it('TicketsPage loads unlinked stats from the authenticated API', () => {
    const source = readPage('pages/dashboard/TicketsPage.jsx');
    assert.match(source, /\/api\/tickets\/stats/);
  });

  it('InvoicesPage staff upload hits the operations endpoint, not the ADMIN simulator', () => {
    const source = readPage('pages/dashboard/InvoicesPage.jsx');
    assert.match(source, /\/api\/invoices\/upload/);
    assert.equal(source.includes('/api/invoices/mock-email'), false);
  });
});
