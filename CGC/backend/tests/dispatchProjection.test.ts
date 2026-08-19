/**
 * Regression tests for the dispatch board's order projection.
 *
 * `GET /api/dispatch` returned 500 for every date in production:
 *
 *   Invalid `prisma.order.findMany()` invocation:
 *   Attempted to serialize non-enum-compatible value 'null' for enum 'BuyerType'
 *
 * 16 of the 1,816 orders hold NULL in `buyerType`, written by a bulk import on
 * 2026-07-12 that bypassed Prisma's `@default(CONTRACTOR)`. The column is
 * declared non-nullable, so reading a full row made Prisma refuse the entire
 * query — one bad row took down the whole endpoint.
 *
 * The failure was invisible because the frontend reads the board from the
 * `fetch-cgc-data` Edge function, which goes through PostgREST and tolerates
 * the NULL. Nobody exercised the Express route.
 *
 * The board renders seven order fields and never touches the supplier relation,
 * so projecting to exactly those fields both fixes the crash and shrinks the
 * payload. These tests pin the projection so a future `include` cannot quietly
 * reintroduce the 500.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import './setupEnv.js';

import { DISPATCH_ORDER_SELECT } from '../src/modules/dispatch/dispatch.service.ts';

/**
 * Comments describe the removed behaviour — the note in `getDispatchBoard`
 * quotes the very `include: { supplier: true }` this file forbids — so the
 * guards must scan code only.
 */
const codeOnly = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const serviceSource = codeOnly(
  readFileSync(
    resolve(import.meta.dirname, '../src/modules/dispatch/dispatch.service.ts'),
    'utf8',
  ),
);

/** Fields DispatchBoard.jsx actually reads off an order. */
const FIELDS_THE_BOARD_RENDERS = [
  'id',
  'spruceOrderId',
  'customerName',
  'product',
  'quantity',
  'unit',
  'createdAt',
];

describe('dispatch board order projection', () => {
  it('selects every field the board renders', () => {
    for (const field of FIELDS_THE_BOARD_RENDERS) {
      assert.equal(
        (DISPATCH_ORDER_SELECT as Record<string, boolean>)[field],
        true,
        `the board renders order.${field}, so the projection must select it`,
      );
    }
  });

  it('does not select buyerType', () => {
    // The whole point: 16 production rows hold NULL in a column Prisma believes
    // is non-nullable, and reading it fails the entire query.
    assert.equal(
      'buyerType' in DISPATCH_ORDER_SELECT,
      false,
      'selecting buyerType reintroduces the 500 on every dispatch request',
    );
  });

  it('selects nothing the board does not use', () => {
    // Keeps the payload honest; the board is the widest read on the app.
    const selected = Object.keys(DISPATCH_ORDER_SELECT);
    assert.deepEqual(
      selected.slice().sort(),
      FIELDS_THE_BOARD_RENDERS.slice().sort(),
      'projection drifted from what the board renders',
    );
  });

  it('reads no order through a bare include anywhere in getDispatchBoard', () => {
    // Three separate queries in this service reach Order — the unassigned pool,
    // each driver's deliveries, and unassigned deliveries. All three hit the
    // same bad rows, so all three must be projected.
    const start = serviceSource.indexOf('async getDispatchBoard');
    const end = serviceSource.indexOf('async assignDriver');
    assert.ok(start > -1 && end > start, 'could not locate getDispatchBoard');
    const body = serviceSource.slice(start, end);

    assert.equal(
      /order:\s*true/.test(body),
      false,
      'a bare `order: true` reads buyerType and will 500 on the NULL rows',
    );
    assert.equal(
      /include:\s*\{\s*supplier:\s*true\s*\}/.test(body),
      false,
      'a full order include reads buyerType and will 500 on the NULL rows',
    );

    const projections = body.match(/DISPATCH_ORDER_SELECT/g) || [];
    assert.ok(
      projections.length >= 3,
      `expected all three Order reads to be projected, found ${projections.length}`,
    );
  });

  it('the comment stripper does not hide real code', () => {
    assert.equal(codeOnly('// order: true was removed\nconst a = 1;').includes('order: true'), false);
    assert.equal(codeOnly('const x = { order: true };').includes('order: true'), true);
    assert.equal(codeOnly("const u = 'https://x/y';").includes('https://x/y'), true);
  });
});
