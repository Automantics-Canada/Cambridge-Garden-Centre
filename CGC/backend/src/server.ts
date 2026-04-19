import app from './app.js';
import { env } from './config/env.js';
import { prisma } from './db/prisma.js';
import { verifyStorageConnection } from './services/supabaseStorage.js';
import { GmailService } from './services/gmail.service.js';

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
      
      // Initialize Gmail Poll Worker (1 minute interval)
      const GMAIL_POLL_INTERVAL = 60 * 1000;
      console.log(`📧 Gmail Sync active every ${GMAIL_POLL_INTERVAL/1000} seconds.`);
      setInterval(() => {
        GmailService.pollInvoices();
      }, GMAIL_POLL_INTERVAL);

      // Run once on startup
      GmailService.pollInvoices();
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
