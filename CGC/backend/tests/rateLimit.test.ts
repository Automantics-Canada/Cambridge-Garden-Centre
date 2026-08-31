import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { rateLimit } from '../src/middleware/rateLimit.js';
import { loginRateLimitKey } from '../src/modules/auth/auth.routes.js';

function responseRecorder() {
  const result = { statusCode: 200, body: undefined as unknown, headers: new Map<string, string>() };
  const response = {
    setHeader(name: string, value: string) {
      result.headers.set(name, value);
    },
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    json(body: unknown) {
      result.body = body;
      return this;
    },
  } as unknown as Response;
  return { response, result };
}

function request(email: string): Request {
  return {
    body: { email },
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
}

describe('login rate limiting', () => {
  it('normalizes an account identifier without storing it in the key', () => {
    const first = loginRateLimitKey(request(' Person@Example.Test '));
    const normalized = loginRateLimitKey(request('person@example.test'));
    assert.equal(first, normalized);
    assert.equal(first.includes('person@example.test'), false);
  });

  it('does not let one account consume another account budget behind the same IP', () => {
    const middleware = rateLimit({
      windowMs: 60_000,
      max: 1,
      name: 'login',
      key: loginRateLimitKey,
    });
    let admitted = 0;
    const next = (() => { admitted += 1; }) as NextFunction;

    const first = responseRecorder();
    middleware(request('first@example.test'), first.response, next);
    assert.equal(admitted, 1);

    const repeated = responseRecorder();
    middleware(request('first@example.test'), repeated.response, next);
    assert.equal(repeated.result.statusCode, 429);
    assert.equal(admitted, 1);

    const secondAccount = responseRecorder();
    middleware(request('second@example.test'), secondAccount.response, next);
    assert.equal(admitted, 2);
    assert.equal(secondAccount.result.statusCode, 200);
  });
});
