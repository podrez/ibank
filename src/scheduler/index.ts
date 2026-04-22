import cron from 'node-cron';
import { syncAllBanks, syncBankBalances, syncAllStatements } from '../scraper';
import { getEnabledBanks, BankAdapter } from '../banks';
import { logger } from '../logger';

const START_HOUR = parseInt(process.env.SCHEDULE_START_HOUR ?? '9');
const END_HOUR = parseInt(process.env.SCHEDULE_END_HOUR ?? '17');
const INTERVAL = parseInt(process.env.SCHEDULE_INTERVAL_MINUTES ?? '5');

let syncTask: cron.ScheduledTask | null = null;
let isSyncing = false;

/**
 * Runs every INTERVAL minutes, Mon–Fri, from START_HOUR to END_HOUR (Minsk time, UTC+3).
 * Minsk time = UTC+3, so 9:00 MSK = 6:00 UTC, 17:00 MSK = 14:00 UTC.
 */
export function startScheduler(): void {
  const utcStart = START_HOUR - 3;
  const utcEnd = END_HOUR - 3 - 1;

  const cronExpr = `*/${INTERVAL} ${utcStart}-${utcEnd} * * 1-5`;
  logger.info('Starting scheduler', {
    cronExpr,
    schedule: `Mon–Fri ${START_HOUR}:00–${END_HOUR}:00 Minsk time, every ${INTERVAL} min`,
  });

  syncTask = cron.schedule(cronExpr, () => runSync(), { timezone: 'UTC' });
  syncTask.start();

  if (isWorkingHour()) {
    logger.info('Within working hours — running initial sync');
    runSync();
  } else {
    logger.info('Outside working hours — waiting for schedule');
  }
}

export function stopScheduler(): void {
  syncTask?.stop();
  syncTask = null;
  logger.info('Scheduler stopped');
}

function isWorkingHour(): boolean {
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours() + 3;
  return day >= 1 && day <= 5 && hour >= START_HOUR && hour < END_HOUR;
}

/**
 * Run sync for all banks, or a specific bank if bankId is provided.
 * Used by the scheduler and the /api/refresh endpoint.
 */
export async function runSync(bankId?: string): Promise<void> {
  if (isSyncing) {
    logger.warn('Sync already in progress — skipping');
    return;
  }
  isSyncing = true;
  try {
    // Instantiate adapters once — reused for both balance and statement sync
    // so statement sync inherits the already-authenticated browser session.
    const banks = getEnabledBanks();

    let activeBanks: BankAdapter[];
    if (bankId) {
      const bank = banks.find((b) => b.id === bankId);
      if (!bank) {
        logger.warn(`Unknown bank id: ${bankId}`);
        return;
      }
      await syncBankBalances(bank);
      activeBanks = [bank];
    } else {
      await syncAllBanks(banks);
      activeBanks = banks;
    }

    await syncAllStatements(undefined, undefined, activeBanks);
  } finally {
    isSyncing = false;
  }
}
