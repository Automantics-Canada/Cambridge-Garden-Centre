import app from './app.js';
import { env } from './config/env.js';
import { prisma } from './db/prisma.js';

async function main() {
  try {
    // Optionally connect to Prisma DB to test connection on startup
    await prisma.$connect();
    console.log('Successfully connected to the database.');

    app.listen(env.port, () => {
      console.log(`Server is running in ${env.nodeEnv} mode on port ${env.port}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
