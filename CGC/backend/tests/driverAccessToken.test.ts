import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env.js';
import {
  buildDriverAccessUrl,
  createDriverAccessToken,
} from '../src/services/driverAccessToken.js';

describe('createDriverAccessToken', () => {
  const user = {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'driver@example.test',
    role: 'DRIVER',
    active: true,
  };

  it('creates a short-lived JWT that authMiddleware can verify', () => {
    const token = createDriverAccessToken(user);
    assert.equal(token.split('.').length, 3);
    const decoded = jwt.verify(token, env.jwtSecret) as jwt.JwtPayload;
    assert.equal(decoded.id, user.id);
    assert.equal(decoded.email, user.email);
    assert.equal(decoded.role, 'DRIVER');
    assert.ok((decoded.exp ?? 0) - (decoded.iat ?? 0) <= 12 * 60 * 60);
  });

  it('refuses unlinked, inactive and non-driver accounts', () => {
    assert.throws(() => createDriverAccessToken(null), /not linked or active/);
    assert.throws(() => createDriverAccessToken({ ...user, active: false }), /not linked or active/);
    assert.throws(() => createDriverAccessToken({ ...user, role: 'ADMIN' }), /not linked or active/);
  });

  it('builds new email links with a fragment so the token is not sent to the web server', () => {
    const url = buildDriverAccessUrl('https://portal.example.test/', 'header.payload.signature');
    assert.equal(
      url,
      'https://portal.example.test/driver/today#token=header.payload.signature'
    );
    assert.equal(url.includes('?token='), false);
  });
});
