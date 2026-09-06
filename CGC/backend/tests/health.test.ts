import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import { shortCommit } from '../src/config/buildInfo.js';

describe('GET /api/health', () => {
  it('shortens a Railway Git SHA and rejects arbitrary environment text', () => {
    assert.equal(shortCommit('5E71ACCF3742DE418E00895C0C380AC169E37585'), '5e71acc');
    assert.equal(shortCommit(' 0319ed3 '), '0319ed3');
    assert.equal(shortCommit(undefined), 'unknown');
    assert.equal(shortCommit('not-a-commit-or-secret'), 'unknown');
  });

  it('is unauthenticated and exposes only status, commit, and build time', async () => {
    process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test';
    process.env.JWT_SECRET = 'health-test-secret';
    process.env.SUPABASE_URL = 'https://health-test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'health-test-service-role';
    process.env.SUPABASE_STORAGE_BUCKET = 'health-test-bucket';
    const { default: app } = await import('../src/app.js');

    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      const payload = await response.json() as Record<string, unknown>;
      const secondPayload = await fetch(`http://127.0.0.1:${port}/api/health`)
        .then(result => result.json()) as Record<string, unknown>;

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(Object.keys(payload).sort(), ['builtAt', 'commit', 'status']);
      assert.equal(payload.status, 'ok');
      assert.match(String(payload.commit), /^(?:unknown|[0-9a-f]{7})$/);
      assert.ok(Number.isFinite(Date.parse(String(payload.builtAt))));
      assert.equal(secondPayload.builtAt, payload.builtAt, 'build time must not change per request');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  });
});
