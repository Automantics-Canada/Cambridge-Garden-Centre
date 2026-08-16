/**
 * Standalone background worker.
 *
 * Runs the Gmail poll, the OCR sweep and the ticket-matching cron with no HTTP
 * server attached, so OCR's CPU-bound PDF rasterisation cannot stall API
 * requests. Start with `npm run start:worker`.
 *
 * See `workers/runtime.ts` for the two-step rollout — this process is deployed
 * first, and only then is the API switched to `WORKER_MODE=off`.
 */
import { env } from './config/env.js';
import { prisma } from './db/prisma.js';
import { startWorkers } from './workers/startWorkers.js';

async function main() {
  try {
    await prisma.$connect();
    console.log(`Worker connected to the database in ${env.nodeEnv} mode.`);

    const stop = startWorkers();

    // Railway sends SIGTERM on redeploy. Stopping the timers and closing the
    // pool lets an in-flight OCR job finish rather than being cut mid-write.
    const shutdown = async (signal: string) => {
      console.log(`Worker received ${signal}; shutting down.`);
      stop();
      await prisma.$disconnect();
      process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (error) {
    console.error('Failed to start worker:', error);
    process.exit(1);
  }
}

main();
