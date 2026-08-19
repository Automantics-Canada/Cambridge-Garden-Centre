import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(new URL('../src/db/prisma.ts', import.meta.url), 'utf8');

describe('Prisma production logging', () => {
  it('keeps query logging development-only while preserving warnings and errors', () => {
    assert.match(source, /NODE_ENV === 'development'/);
    assert.match(source, /\['query', 'error', 'warn', 'info'\]/);
    assert.match(source, /\['error', 'warn'\]/);
  });
});
