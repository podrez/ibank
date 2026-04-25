import cron, { type ScheduledTask } from 'node-cron';
import { syncAllBanks, syncBankBalances, syncAllStatements } from '../scraper';
import { getEnabledBanks, BankAdapter } from '../banks';
import { logger } from '../logger';

const START_HOUR = parseInt(process.env.SCHEDULE_START_HOUR ?? '9');
const END_HOUR = parseInt(process.env.SCHEDULE_END_HOUR ?? '17');
const INTERVAL = parseInt(process.env.SCHEDULE_INTERVAL_MINUTES ?? '5');

// Comma-separated dates (YYYY-MM-DD) that are working days despite being Sat/Sun.
// Example: EXTRA_WORKING_DAYS=2026-04-25,2026-11-07
const EXTRA_WORKING_DAYS: Set<string> = new Set(
  (process.env.EXTRA_WORKING_DAYS ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean)
);

let syncTask: ScheduledTask | null = null;
let isSyncing = false;

function todayMinsk(): string {
  const now = new Date();
  // UTC+3
  const minsk = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return minsk.toISOString().slice(0, 10);
}

function isWorkingDay(): boolean {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 6=Sat
  if (day >= 1 && day <= 5) return true; // Mon–Fri always working
  return EXTRA_WORKING_DAYS.has(todayMinsk()); // Sat/Sun if explicitly listed
}

/**
 * Runs every INTERVAL minutes, Mon–Sat (extended for transferred working days),
 * from START_HOUR to END_HOUR (Minsk time, UTC+3). The actual working-day check
 * happens inside the callback so Saturdays run only when listed in EXTRA_WORKING_DAYS.
 */
export function startScheduler(): void {
  const utcStart = START_HOUR - 3;
  const utcEnd = END_HOUR - 3 - 1;

  // 1-6 covers Mon–Sat; Sunday transfers are rare but handled via EXTRA_WORKING_DAYS too
  const cronExpr = `*/${INTERVAL} ${utcStart}-${utcEnd} * * 0-6`;
  logger.info('Starting scheduler', {
    cronExpr,
    schedule: `Mon–Fri ${START_HOUR}:00–${END_HOUR}:00 Minsk time, every ${INTERVAL} min (+ extra working days: ${[...EXTRA_WORKING_DAYS].join(', ') || 'none'})`,
  });

  syncTask = cron.schedule(
    cronExpr,
    () => {
      if (!isWorkingDay()) return;
      runSync();
    },
    { timezone: 'UTC' }
  );
  syncTask.start();

  if (isWorkingDay() && isWorkingHour()) {
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
  const hour = now.getUTCHours() + 3;
  return hour >= START_HOUR && hour < END_HOUR;
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
