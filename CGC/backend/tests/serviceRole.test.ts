/**
 * Service-role bearer check used by send-credentials.
 *
 * The published anon key is a valid project JWT, so gateway verify_jwt is
 * not enough. This helper is the app-level gate.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isServiceRoleBearer } from '../../supabase/functions/_shared/serviceRole.ts';

const SERVICE = 'service-role-secret-value';
const ANON = 'anon-key-that-must-never-pass';

describe('isServiceRoleBearer', () => {
  it('admits an exact Bearer service-role key', () => {
    assert.equal(isServiceRoleBearer(`Bearer ${SERVICE}`, SERVICE), true);
  });

  it('denies the published anon key', () => {
    assert.equal(isServiceRoleBearer(`Bearer ${ANON}`, SERVICE), false);
  });

  it('denies a missing header, missing key, or empty values', () => {
    assert.equal(isServiceRoleBearer(null, SERVICE), false);
    assert.equal(isServiceRoleBearer(undefined, SERVICE), false);
    assert.equal(isServiceRoleBearer(`Bearer ${SERVICE}`, null), false);
    assert.equal(isServiceRoleBearer(`Bearer ${SERVICE}`, ''), false);
    assert.equal(isServiceRoleBearer('Bearer ', SERVICE), false);
    assert.equal(isServiceRoleBearer(SERVICE, SERVICE), false);
  });

  it('denies a prefix or suffix of the expected key', () => {
    assert.equal(isServiceRoleBearer(`Bearer ${SERVICE}extra`, SERVICE), false);
    assert.equal(isServiceRoleBearer(`Bearer ${SERVICE.slice(0, -1)}`, SERVICE), false);
  });
});
