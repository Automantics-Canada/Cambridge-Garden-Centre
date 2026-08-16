import { env } from './config/env.js';
import app from './app.js';
import { prisma } from './db/prisma.js';
import { verifyStorageConnection } from './services/supabaseStorage.js';
import { startWorkers } from './workers/startWorkers.js';
import { resolveWorkerMode, shouldRunWorkersInProcess } from './workers/runtime.js';
async function main() {
  try {
    // Optionally connect to Prisma DB to test connection on startup
    await prisma.$connect();
    console.log('Successfully connected to the database.');

    // Verify Supabase Storage connection
    console.log('\n📦 Initializing Supabase Storage...');
    const storageConnected = await verifyStorageConnection();
    if (!storageConnected) {
      console.warn('⚠️  Supabase Storage connection failed, uploads will not work');
    }

    app.listen(env.port, () => {
      console.log(`Server is running in ${env.nodeEnv} mode on port ${env.port}`);

      // The Spruce EOD reconciliation job used to run here. It never compared
      // anything — it hard-coded a match and stamped `Ticket.spruceMatched`
      // every night — so it was removed rather than left to keep asserting a
      // result it had not computed. Reinstate it only with a real comparison.

      // OCR rasterises PDFs on this event loop, so running the workers here
      // stalls HTTP. `WORKER_MODE=off` moves them to the worker service; the
      // default keeps them inline so an unconfigured deploy still processes
      // documents. See workers/runtime.ts for the rollout order.
      if (shouldRunWorkersInProcess()) {
        console.log('⚙️  Background workers running in-process (WORKER_MODE=inline).');
        startWorkers();
      } else {
        console.log(`⚙️  Background workers disabled here (WORKER_MODE=${resolveWorkerMode()}); expecting a separate worker service.`);
      }
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
