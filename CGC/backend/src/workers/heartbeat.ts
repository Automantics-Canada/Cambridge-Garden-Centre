import { prisma } from '../db/prisma.js';
import { buildInfo } from '../config/buildInfo.js';

/**
 * Which code the background worker is actually running.
 *
 * The backend is deployed as two Railway services from one repository: the API
 * (`WORKER_MODE=off`) and a worker (`npm run start:worker`). Only the API
 * serves HTTP, so `GET /api/health` reports the API's build and nothing at all
 * about the worker's. Nothing in the product could answer "is the worker on the
 * same commit as the API?", and a worker left behind on an older deploy goes on
 * running old logic against the current database with no symptom anyone can
 * attribute to it.
 *
 * That is not hypothetical. After the matching change shipped, a manually
 * uploaded ticket was linked by the engine and then unlinked about a minute
 * later, with the engine's own `TicketOrderMatch` row left behind — the exact
 * signature of the previous cron, which ran every minute, unlinked auto-linked
 * tickets that had no driver, and deleted only the three older `AUTO_*` methods.
 * Diagnosing that took a guess, because the only evidence was the shape of the
 * damage.
 *
 * So the worker writes down who it is. Each heartbeat records the commit, the
 * build time, the moment it was written and whether it came from the standalone
 * worker or from an API process running the workers inline; the health endpoint
 * reads them back and says whether the worker is still beating and whether it
 * agrees with the API.
 *
 * This makes a stale worker visible. It does not prevent one.
 */

/** How often the worker says it is still here. */
export const HEARTBEAT_INTERVAL_MS = 60 * 1000;

/**
 * How long without a heartbeat before the worker is reported stale.
 *
 * Three intervals. One missed write is a slow query or a redeploy; three in a
 * row means nothing is running, and calling that stale after a single miss
 * would cry wolf through every deployment.
 */
export const HEARTBEAT_STALE_AFTER_MS = 3 * HEARTBEAT_INTERVAL_MS;

/**
 * Where the worker runs.
 *
 * Distinct from `WorkerMode` in runtime.ts, which is the API's setting. This is
 * the answer to "which process wrote this heartbeat", and the two disagreeing —
 * an API on `WORKER_MODE=off` while the only heartbeats say `inline` — is
 * itself worth seeing.
 */
export type WorkerProcessMode = 'inline' | 'separate';

/** `SystemSetting` keys. Namespaced like the `match.` tolerance keys. */
export const HEARTBEAT_KEYS = {
  commit: 'worker.commit',
  builtAt: 'worker.builtAt',
  lastSeenAt: 'worker.lastSeenAt',
  mode: 'worker.mode',
} as const;

/** What the worker last wrote down, as read back. Any field may be missing. */
export interface WorkerHeartbeat {
  commit: string | null;
  builtAt: string | null;
  lastSeenAt: string | null;
  mode: string | null;
}

/** What `GET /api/health` reports under `worker`. */
export interface WorkerHealth extends WorkerHeartbeat {
  /** No heartbeat, or the last one is older than the stale window. */
  stale: boolean;
  /** The worker and the API are provably on the same commit. */
  matchesApi: boolean;
}

/**
 * Reads a `SystemSetting` JSON value as a string, or null.
 *
 * `SystemSetting.value` is a Json column, so a row written by hand could hold a
 * number, an object or null. Anything that is not a non-empty string is treated
 * as absent rather than coerced — a heartbeat nobody can read is not evidence
 * of a worker.
 */
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Derives what the health endpoint says from a heartbeat and the API's commit.
 *
 * Pure, and separated from both the read and the write so the two judgements
 * that matter — is it stale, does it match — can be tested without a database
 * or a clock.
 */
export function deriveWorkerHealth(
  heartbeat: WorkerHeartbeat | null,
  apiCommit: string,
  now: Date = new Date()
): WorkerHealth {
  const commit = heartbeat?.commit ?? null;
  const builtAt = heartbeat?.builtAt ?? null;
  const lastSeenAt = heartbeat?.lastSeenAt ?? null;
  const mode = heartbeat?.mode ?? null;

  // An absent or unreadable timestamp is stale. The question this answers is
  // "do we have evidence the worker is alive", and no timestamp is no evidence.
  const seenAtMs = lastSeenAt ? Date.parse(lastSeenAt) : Number.NaN;
  const stale =
    !Number.isFinite(seenAtMs) || now.getTime() - seenAtMs > HEARTBEAT_STALE_AFTER_MS;

  // `unknown` is what `shortCommit` returns when Railway did not set the SHA,
  // and two unknowns are not a match — they are two absences. Reporting that as
  // agreement would put a green tick on exactly the situation this exists to
  // expose.
  const matchesApi =
    commit !== null && commit !== 'unknown' && apiCommit !== 'unknown' && commit === apiCommit;

  return { commit, builtAt, lastSeenAt, mode, stale, matchesApi };
}

/**
 * Records one heartbeat. Never throws.
 *
 * All four rows in one transaction, so a reader can never catch a commit from
 * this deploy beside a timestamp from the last one — the torn state would look
 * exactly like the stale worker this is meant to detect.
 *
 * `SystemSetting.updatedAt` only defaults on insert, so the timestamp is
 * written explicitly rather than inferred from the row.
 */
export async function writeWorkerHeartbeat(mode: WorkerProcessMode): Promise<void> {
  const now = new Date().toISOString();
  const values: Array<[string, string]> = [
    [HEARTBEAT_KEYS.commit, buildInfo.commit],
    [HEARTBEAT_KEYS.builtAt, buildInfo.builtAt],
    [HEARTBEAT_KEYS.lastSeenAt, now],
    [HEARTBEAT_KEYS.mode, mode],
  ];

  try {
    await prisma.$transaction(
      values.map(([key, value]) =>
        prisma.systemSetting.upsert({
          where: { key },
          create: { key, value, updatedAt: new Date() },
          update: { value, updatedAt: new Date() },
        })
      )
    );
  } catch (error) {
    // Reporting on the worker must never be able to stop the worker. A failed
    // heartbeat shows up as staleness a minute later, which is the right
    // outcome: something is wrong with this process's database access.
    console.error('[Heartbeat] Could not record the worker heartbeat:', error);
  }
}

/**
 * Reads the last heartbeat, or null when there is none or it cannot be read.
 *
 * Called from the health endpoint, so a database problem must surface as "no
 * heartbeat" rather than as a failed health check — see the endpoint for why
 * that distinction matters to a deployment.
 */
export async function readWorkerHeartbeat(): Promise<WorkerHeartbeat | null> {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { startsWith: 'worker.' } },
    select: { key: true, value: true },
  });

  if (rows.length === 0) return null;

  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  return {
    commit: asString(byKey.get(HEARTBEAT_KEYS.commit)),
    builtAt: asString(byKey.get(HEARTBEAT_KEYS.builtAt)),
    lastSeenAt: asString(byKey.get(HEARTBEAT_KEYS.lastSeenAt)),
    mode: asString(byKey.get(HEARTBEAT_KEYS.mode)),
  };
}

/**
 * Starts the heartbeat and returns a stop function.
 *
 * Writes once immediately: the most useful moment to know which code just
 * started is the moment it starts, and waiting a minute for the first record
 * would leave the window after a deploy — exactly when a stale worker is
 * suspected — with nothing in it.
 */
export function startWorkerHeartbeat(mode: WorkerProcessMode): () => void {
  console.log(
    `💓 Worker heartbeat every ${HEARTBEAT_INTERVAL_MS / 1000}s ` +
      `(build ${buildInfo.commit}, ${mode}).`
  );

  void writeWorkerHeartbeat(mode);
  const timer = setInterval(() => void writeWorkerHeartbeat(mode), HEARTBEAT_INTERVAL_MS);

  // The worker process holds the event loop open with its own timers; this one
  // must not be the reason a process that is otherwise done refuses to exit.
  timer.unref?.();

  return () => clearInterval(timer);
}
