import './setupEnv.js';
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/prisma.js';
import {
  acquirePollLease,
  POLL_LEASE_KEY,
  POLL_LEASE_MS,
  releasePollLease,
  renewPollLease,
} from '../src/services/gmailLease.js';

/**
 * The inbox poll lease against a real PostgreSQL: the JSON holder filter and
 * the conditional UPDATE that lets only one process win.
 *
 * Loopback, disposable database only (scripts/run-tests.mjs). The holders are
 * invented names.
 */

const confirmed = process.env.CGC_TEST_CONFIRM_DISPOSABLE === '1';
const loopback = (() => {
  try {
    return ['127.0.0.1', 'localhost', '::1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname);
  } catch {
    return false;
  }
})();

const T0 = new Date('2026-11-03T15:00:00Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

describe('inbox poll lease', { skip: !(confirmed && loopback) }, () => {
  beforeEach(async () => {
    await prisma.systemSetting.deleteMany({ where: { key: POLL_LEASE_KEY } });
  });
  after(async () => {
    await prisma.systemSetting.deleteMany({ where: { key: POLL_LEASE_KEY } });
    await prisma.$disconnect();
  });

  it('one holder at a time; the holder renews, the other cannot', async () => {
    assert.equal(await acquirePollLease('api-1', T0), true);
    assert.equal(await acquirePollLease('worker-1', later(1000)), false);
    assert.equal(await renewPollLease('worker-1', later(1000)), false);
    assert.equal(await renewPollLease('api-1', later(60_000)), true);
    assert.equal(await acquirePollLease('api-1', later(61_000)), true, 'the holder may take it again');
    // Renewed at +61s, so still held at +61s + most of the lease.
    assert.equal(await acquirePollLease('worker-1', later(61_000 + POLL_LEASE_MS - 1000)), false);
  });

  it('a lease its holder stopped renewing is taken over, and the old holder cannot renew it', async () => {
    assert.equal(await acquirePollLease('api-1', T0), true);
    assert.equal(await acquirePollLease('worker-1', later(POLL_LEASE_MS + 1000)), true);
    assert.equal(await renewPollLease('api-1', later(POLL_LEASE_MS + 2000)), false);
  });

  it('a released lease is free at once; a release by somebody else changes nothing', async () => {
    assert.equal(await acquirePollLease('api-1', T0), true);
    await releasePollLease('worker-1');
    assert.equal(await acquirePollLease('worker-1', later(1000)), false);
    await releasePollLease('api-1');
    assert.equal(await acquirePollLease('worker-1', later(2000)), true);
  });

  it('many processes asking at once: exactly one wins, whether the row is new or stale', async () => {
    const holders = ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6'];
    const first = await Promise.all(holders.map((holder) => acquirePollLease(holder, T0)));
    assert.equal(first.filter(Boolean).length, 1);

    const stale = later(POLL_LEASE_MS + 5000);
    const second = await Promise.all(holders.map((holder) => acquirePollLease(`${holder}-b`, stale)));
    assert.equal(second.filter(Boolean).length, 1);
  });
});
