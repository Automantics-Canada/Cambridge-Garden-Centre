/**
 * Where the background workers run.
 *
 * The API process also ran the Gmail poll, the OCR worker and the cron jobs on
 * one event loop and one Railway instance. OCR rasterises PDFs in-process,
 * which is heavy CPU work, so every scan stalled the HTTP server — the dispatch
 * board's assign and reorder calls sat behind it.
 *
 * Splitting them cannot be a single switch, because the moment the API stops
 * running the workers, nothing processes documents until a worker service
 * exists. So the mode is explicit and the rollout is two steps:
 *
 *   1. Deploy the worker service (`npm run start:worker`) while the API is
 *      still `inline`. Both run the pollers; the OCR claim query tolerates it,
 *      and the Gmail poller is idempotent on `gmailMessageId`.
 *   2. Set `WORKER_MODE=off` on the API service. It now serves HTTP only.
 *
 * Reverting is step 2 in reverse, and needs no code change.
 */
export type WorkerMode = 'inline' | 'off';

/**
 * `inline` by default so an unconfigured deployment keeps behaving as it does
 * today. A missing variable must not silently stop document processing.
 */
export function resolveWorkerMode(): WorkerMode {
  return process.env.WORKER_MODE === 'off' ? 'off' : 'inline';
}

/** True when this process should run the background workers itself. */
export function shouldRunWorkersInProcess(): boolean {
  return resolveWorkerMode() === 'inline';
}
