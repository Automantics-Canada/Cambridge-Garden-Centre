/**
 * `DriverService.deleteDriver` loaded the driver with `include: { user: true }`
 * and then returned that record straight to the client
 * (`driver.controller.ts` → `res.json(result)` on `DELETE /drivers/:id`).
 * `User` carries `passwordHash`, so the delete response handed the linked
 * user's bcrypt hash to any OWNER or ADMIN.
 *
 * The include was never needed: the cleanup below it only reads the `userId`
 * scalar, which already lives on `Driver`.
 *
 * This is a source-level guard, not a behavioural one. `deleteDriver` calls
 * `prisma.$transaction` on an imported singleton with no seam to inject a fake,
 * and this repo has no Prisma mock harness — the other tests here inspect
 * routers and pure functions. Rather than build a mocking layer for one
 * assertion, or leave the regression uncovered, this reads the function body.
 * If `deleteDriver` is ever refactored behind a seam, replace this with a real
 * response-shape assertion.
 */
import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(
  path.join(here, '../src/modules/drivers/driver.service.ts'),
  'utf8'
);

/**
 * Strip comments before matching. The fix itself is documented in a comment that
 * quotes the offending `include: { user: true }`, so a naive scan of the raw
 * source matches the prose describing the bug rather than the bug.
 */
function stripComments(input: string): string {
  return input.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const source = stripComments(raw);

/** Extract a method body by brace matching from `async <name>(` to its close. */
function methodBody(name: string): string {
  const start = source.indexOf(`async ${name}(`);
  assert.notEqual(start, -1, `${name} not found in driver.service.ts`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

describe('deleteDriver response shape', () => {
  it('does not expand the linked user', () => {
    const body = methodBody('deleteDriver');
    assert.equal(
      /include\s*:\s*\{\s*user\s*:\s*true\s*\}/.test(body),
      false,
      'deleteDriver returns this record to the client; user: true leaks passwordHash'
    );
  });

  it('still reads the userId scalar it needs for cleanup', () => {
    // The linked-user deletion must survive the projection change; without this
    // the fix could "pass" by dropping the cleanup entirely.
    const body = methodBody('deleteDriver');
    assert.match(body, /driver\.userId/, 'linked-user cleanup must still run');
    assert.match(body, /tx\.user\.delete/, 'linked user must still be deleted');
  });

  it('the brace matcher actually isolates the method', () => {
    // Guards the helper itself: updateDriver is a different method, and its own
    // user include is internal — never returned to a client.
    const body = methodBody('deleteDriver');
    assert.equal(body.includes('updateDriver'), false);
    assert.match(body, /driverId: null|tx\.driver\.delete/);
  });

  it('the guard can still fail, and comment-stripping has not blinded it', () => {
    // Without this, a bad strip regex would make every assertion above vacuous.
    const withInclude = 'async x() { const a = await tx.driver.findUnique({ include: { user: true } }); }';
    assert.match(stripComments(withInclude), /include\s*:\s*\{\s*user\s*:\s*true\s*\}/);
    // ...and a comment mentioning the pattern is correctly ignored.
    assert.doesNotMatch(
      stripComments('// include: { user: true }\nconst a = 1;'),
      /include\s*:\s*\{\s*user\s*:\s*true\s*\}/
    );
    // updateDriver still carries a real (internal, non-returned) occurrence,
    // proving the file genuinely contains the pattern the guard looks for.
    assert.match(source, /include\s*:\s*\{\s*user\s*:\s*true\s*\}/);
  });
});
