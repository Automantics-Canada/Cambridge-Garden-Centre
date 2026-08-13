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

/**
 * Detect a PostgREST table read on the anon client.
 *
 * Whitespace is stripped before matching. A plain `includes('supabase.from(')`
 * looks correct but silently misses the shape the original defect actually had,
 * because the call was split across lines:
 *
 *     const { count, error } = await supabase
 *       .from('Ticket')
 *
 * The self-check below pins that, so this matcher cannot quietly rot back into
 * a test that always passes.
 */
function containsAnonTableAccess(source: string): boolean {
  return source.replace(/\s+/g, '').includes('supabase.from(');
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
      assert.equal(containsAnonTableAccess(readPage(page)), false, page);
    });
  }

  it('the matcher itself catches the multi-line form the original defect used', () => {
    // Verbatim shape of the violation that shipped in TicketsPage before the
    // polling rewrite. A naive substring check passes on this, which is exactly
    // how it survived an earlier review.
    const historicalViolation = `
      const { count, error } = await supabase
        .from('Ticket')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'UNLINKED');
    `;
    assert.equal(containsAnonTableAccess(historicalViolation), true);
    assert.equal(
      historicalViolation.includes('supabase.from('),
      false,
      'the naive check must be shown to miss it, or this guard proves nothing'
    );
  });

  it('the matcher does not fire on the authenticated replacement', () => {
    const replacement = `const res = await api.get('/api/tickets/stats');`;
    assert.equal(containsAnonTableAccess(replacement), false);
  });

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
