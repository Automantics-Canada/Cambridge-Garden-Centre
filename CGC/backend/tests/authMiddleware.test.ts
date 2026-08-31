/**
 * Token-rejection paths for authMiddleware.
 *
 * Scope note: these cases all fail before any database call, so they run
 * without a database. The "valid signature, but the account is now inactive or
 * deleted" case is covered by the resolveActiveUser tests in
 * authorization.test.ts, which is the function this middleware delegates to.
 */
import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import { authMiddleware } from '../src/middleware/authMiddleware.js';

const SECRET = process.env.JWT_SECRET!;

function responseDouble() {
  const captured: { status?: number; body?: any } = {};
  const res: any = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  };
  return { res, captured };
}

async function run(req: any) {
  const { res, captured } = responseDouble();
  let advanced = false;
  await authMiddleware(req, res, () => { advanced = true; });
  return { captured, advanced };
}

describe('authMiddleware', () => {
  it('denies an anonymous request with no Authorization header', async () => {
    const { captured, advanced } = await run({ query: {}, headers: {} });
    assert.equal(captured.status, 401);
    assert.equal(advanced, false);
  });

  it('denies a non-Bearer Authorization header', async () => {
    const { captured, advanced } = await run({
      query: {},
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    assert.equal(captured.status, 401);
    assert.equal(advanced, false);
  });

  it('denies a malformed bearer token', async () => {
    const { captured, advanced } = await run({
      query: {},
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    assert.equal(captured.status, 401);
    assert.equal(advanced, false);
  });

  it('denies an expired token', async () => {
    const expired = jwt.sign(
      { id: 'user-1', email: 'ap@example.test', role: 'AP_USER' },
      SECRET,
      { expiresIn: '-60s' }
    );
    const { captured, advanced } = await run({
      query: {},
      headers: { authorization: `Bearer ${expired}` },
    });
    assert.equal(captured.status, 401);
    assert.equal(advanced, false);
  });

  it('denies a token signed with the wrong secret', async () => {
    const forged = jwt.sign(
      { id: 'user-1', email: 'ap@example.test', role: 'ADMIN' },
      'a-different-secret',
      { expiresIn: '1h' }
    );
    const { captured, advanced } = await run({
      query: {},
      headers: { authorization: `Bearer ${forged}` },
    });
    assert.equal(captured.status, 401);
    assert.equal(advanced, false);
  });

  it('denies an unsigned "alg: none" token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ id: 'user-1', email: 'x@example.test', role: 'ADMIN' })
    ).toString('base64url');
    const { captured, advanced } = await run({
      query: {},
      headers: { authorization: `Bearer ${header}.${payload}.` },
    });
    assert.equal(captured.status, 401);
    assert.equal(advanced, false);
  });

  it('denies the legacy base64 driver token that used to bypass authentication', async () => {
    // Pre-stabilization this value authenticated as the named driver with no
    // signature at all. It must now be treated as an ordinary invalid token.
    const legacy = Buffer.from('some-driver-uuid:whatever').toString('base64');
    const { captured, advanced } = await run({ query: { token: legacy }, headers: {} });
    assert.equal(captured.status, 401);
    assert.equal(advanced, false);
  });

  it('never treats a query parameter as an authentication credential', async () => {
    const valid = jwt.sign({ id: 'user-1', email: 'a@b.test', role: 'AP_USER' }, SECRET, {
      expiresIn: '1h',
    });
    const { captured, advanced } = await run({ query: { token: valid }, headers: {} });
    assert.equal(captured.status, 401);
    assert.equal(advanced, false);
  });
});
