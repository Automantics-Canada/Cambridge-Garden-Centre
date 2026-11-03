import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertDemoDatabase } from '../src/scripts/seedDemo.js';

/**
 * The demo seed empties every table of the database it is pointed at, so it
 * must refuse anything that is not a throwaway local database. Every URL here
 * is invented; nothing is connected to.
 */

const LOCAL = 'postgresql://cgctest:cgctest@127.0.0.1:55432/cgc_demo';

describe('demo seed guard', () => {
  it('accepts a loopback database outside production', () => {
    assert.doesNotThrow(() => assertDemoDatabase({ DATABASE_URL: LOCAL, DIRECT_URL: LOCAL, NODE_ENV: 'development' }));
    assert.doesNotThrow(() => assertDemoDatabase({ DATABASE_URL: 'postgresql://u:p@localhost:5432/demo' }));
    assert.doesNotThrow(() => assertDemoDatabase({ DATABASE_URL: 'postgres://u:p@[::1]:5432/demo' }));
  });

  it('refuses a remote host', () => {
    assert.throws(
      () => assertDemoDatabase({ DATABASE_URL: 'postgresql://u:p@db.remote-host.example:5432/postgres' }),
      /non-loopback database \(DATABASE_URL host: db\.remote-host\.example\)/
    );
  });

  it('refuses a remote DIRECT_URL even when DATABASE_URL is local', () => {
    assert.throws(
      () => assertDemoDatabase({ DATABASE_URL: LOCAL, DIRECT_URL: 'postgresql://u:p@10.1.2.3:5432/postgres' }),
      /DIRECT_URL host: 10\.1\.2\.3/
    );
  });

  it('refuses a host parameter that points elsewhere', () => {
    assert.throws(
      () => assertDemoDatabase({ DATABASE_URL: `${LOCAL}?host=db.remote-host.example` }),
      /host parameter/
    );
  });

  it('refuses NODE_ENV=production, even on loopback', () => {
    assert.throws(
      () => assertDemoDatabase({ DATABASE_URL: LOCAL, NODE_ENV: 'production' }),
      /NODE_ENV=production/
    );
  });

  it('refuses a missing or unreadable DATABASE_URL', () => {
    assert.throws(() => assertDemoDatabase({}), /DATABASE_URL is required/);
    assert.throws(() => assertDemoDatabase({ DATABASE_URL: 'not a url' }), /not a valid database URL/);
    assert.throws(() => assertDemoDatabase({ DATABASE_URL: 'mysql://u:p@127.0.0.1/demo' }), /postgresql:\/\//);
  });
});
