import 'dotenv/config';
import { runMigrations } from './db';
import { startApiServer } from './api';
import { startScheduler, stopScheduler } from './scheduler';
import { closeBrowser } from './scraper/browser';
import { logger } from './logger';

async function main() {
  logger.info('Account Balance Service starting');

  runMigrations();
  logger.info('Database ready');

  startApiServer();
  startScheduler();

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down`);
    stopScheduler();
    await closeBrowser();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('Fatal error', { error: (err as Error).message });
  process.exit(1);
});
