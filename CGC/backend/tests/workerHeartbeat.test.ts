import './setupEnv.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEARTBEAT_STALE_AFTER_MS,
  deriveWorkerHealth,
  type WorkerHeartbeat,
} from '../src/workers/heartbeat.js';

/**
 * Whether the background worker is running the code we think it is.
 *
 * The worker has no HTTP surface, so this derivation is the only answer anybody
 * gets. The cases that matter are the ones where it could report agreement it
 * has not established: a worker that stopped writing an hour ago, a timestamp
 * that will not parse, and two builds that are both "unknown". Each of those
 * would put a green tick on exactly the situation this exists to expose.
 */

const NOW = new Date('2026-09-14T12:00:00.000Z');

function heartbeat(overrides: Partial<WorkerHeartbeat> = {}): WorkerHeartbeat {
  return {
    commit: '454cb88',
    builtAt: '2026-09-14T11:00:00.000Z',
    lastSeenAt: NOW.toISOString(),
    mode: 'separate',
    ...overrides,
  };
}

describe('deriveWorkerHealth', () => {
  test('a worker beating on the API build is fresh and matching', () => {
    const health = deriveWorkerHealth(heartbeat(), '454cb88', NOW);

    assert.equal(health.stale, false);
    assert.equal(health.matchesApi, true);
    assert.equal(health.commit, '454cb88');
    assert.equal(health.mode, 'separate');
    assert.equal(health.builtAt, '2026-09-14T11:00:00.000Z');
  });

  test('a worker on an older commit is reported as not matching', () => {
    // The failure this was built for: the API redeployed, the worker did not,
    // and the only evidence was the shape of the damage it did.
    const health = deriveWorkerHealth(heartbeat({ commit: 'd46fe1b' }), '454cb88', NOW);

    assert.equal(health.matchesApi, false);
    assert.equal(health.stale, false, 'an old build still beating is not stale, it is wrong');
    assert.equal(health.commit, 'd46fe1b');
  });

  test('a heartbeat just inside the window is not stale', () => {
    const lastSeenAt = new Date(NOW.getTime() - HEARTBEAT_STALE_AFTER_MS + 1_000).toISOString();
    assert.equal(deriveWorkerHealth(heartbeat({ lastSeenAt }), '454cb88', NOW).stale, false);
  });

  test('a heartbeat past the window is stale', () => {
    const lastSeenAt = new Date(NOW.getTime() - HEARTBEAT_STALE_AFTER_MS - 1_000).toISOString();
    assert.equal(deriveWorkerHealth(heartbeat({ lastSeenAt }), '454cb88', NOW).stale, true);
  });

  test('no heartbeat at all is stale, never a pass', () => {
    // A worker that has never written is not a healthy worker; it is a worker
    // nobody has heard from. Reporting that as fresh would be worse than saying
    // nothing, because somebody would stop looking.
    const health = deriveWorkerHealth(null, '454cb88', NOW);

    assert.equal(health.stale, true);
    assert.equal(health.matchesApi, false);
    assert.equal(health.commit, null);
    assert.equal(health.builtAt, null);
    assert.equal(health.lastSeenAt, null);
    assert.equal(health.mode, null);
  });

  test('a timestamp that will not parse is stale', () => {
    for (const lastSeenAt of ['', 'yesterday', 'not-a-date']) {
      const health = deriveWorkerHealth(heartbeat({ lastSeenAt }), '454cb88', NOW);
      assert.equal(health.stale, true, `"${lastSeenAt}" should be stale`);
    }
  });

  test('a missing commit never matches', () => {
    assert.equal(deriveWorkerHealth(heartbeat({ commit: null }), '454cb88', NOW).matchesApi, false);
  });

  test('two unknown builds are two absences, not a match', () => {
    // `shortCommit` returns "unknown" when the SHA is absent, which is every
    // local run. Calling that agreement would mean the check reads green in
    // precisely the environments where it has learned nothing.
    const health = deriveWorkerHealth(heartbeat({ commit: 'unknown' }), 'unknown', NOW);
    assert.equal(health.matchesApi, false);

    assert.equal(deriveWorkerHealth(heartbeat(), 'unknown', NOW).matchesApi, false);
    assert.equal(
      deriveWorkerHealth(heartbeat({ commit: 'unknown' }), '454cb88', NOW).matchesApi,
      false
    );
  });

  test('a worker running inline is reported as such', () => {
    // An API on WORKER_MODE=off while the only heartbeats say `inline` means
    // the split rollout has not actually happened.
    assert.equal(deriveWorkerHealth(heartbeat({ mode: 'inline' }), '454cb88', NOW).mode, 'inline');
  });

  test('staleness and matching are judged independently', () => {
    // A stale heartbeat on the right commit still reports the commit it saw:
    // "it agreed when it last spoke" and "it is still speaking" are different
    // questions, and collapsing them would hide half of each answer.
    const lastSeenAt = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const health = deriveWorkerHealth(heartbeat({ lastSeenAt }), '454cb88', NOW);

    assert.equal(health.stale, true);
    assert.equal(health.matchesApi, true);
  });

  test('the default clock is now, so a fresh heartbeat is fresh', () => {
    const health = deriveWorkerHealth(heartbeat({ lastSeenAt: new Date().toISOString() }), 'unknown');
    assert.equal(health.stale, false);
  });
});
