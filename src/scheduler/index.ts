import cron, { type ScheduledTask } from 'node-cron';
import { syncAllBanks, syncBankBalances, syncAllStatements } from '../scraper';
import { getEnabledBanks, BankAdapter } from '../banks';
import { logger } from '../logger';
import { getConfig } from '../config/store';

let syncTask: ScheduledTask | null = null;
let isSyncing = false;

function getStartHour(): number { return parseInt(getConfig('SCHEDULE_START_HOUR') ?? '9'); }
function getEndHour(): number   { return parseInt(getConfig('SCHEDULE_END_HOUR') ?? '17'); }
function getInterval(): number  { return parseInt(getConfig('SCHEDULE_INTERVAL_MINUTES') ?? '5'); }
function getTimezone(): string  { return getConfig('APP_TIMEZONE') ?? 'Europe/Minsk'; }

function getExtraWorkingDays(): Set<string> {
  return new Set(
    (getConfig('EXTRA_WORKING_DAYS') ?? '')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean),
  );
}

function todayLocal(): string {
  return new Intl.DateTimeFormat('sv', { timeZone: getTimezone() }).format(new Date());
}

function isWorkingDay(): boolean {
  const today = todayLocal();
  if (getExtraWorkingDays().has(today)) return true;
  const dow = new Date(today).getUTCDay();
  return dow >= 1 && dow <= 5;
}

/**
 * Runs every INTERVAL minutes, Mon–Sat (extended for transferred working days),
 * from START_HOUR to END_HOUR (APP_TIMEZONE). The actual working-day check
 * happens inside the callback so Saturdays run only when listed in EXTRA_WORKING_DAYS.
 */
export function startScheduler(): void {
  const startHour = getStartHour();
  const endHour   = getEndHour();
  const interval  = getInterval();
  const timezone  = getTimezone();
  const extraDays = getExtraWorkingDays();

  // END_HOUR-1: cron range is inclusive — last tick at (END_HOUR-1):xx, not at END_HOUR:00.
  const cronExpr = `*/${interval} ${startHour}-${endHour - 1} * * 0-6`;
  logger.info('Starting scheduler', {
    cronExpr,
    timezone,
    schedule: `Mon–Fri ${startHour}:00–${endHour}:00 ${timezone}, every ${interval} min (+ extra working days: ${[...extraDays].join(', ') || 'none'})`,
  });

  syncTask = cron.schedule(
    cronExpr,
    () => {
      if (!isWorkingDay()) return;
      runSync();
    },
    { timezone },
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
  const hour = parseInt(new Intl.DateTimeFormat('en', { timeZone: getTimezone(), hour: 'numeric', hour12: false }).format(new Date()));
  return hour >= getStartHour() && hour < getEndHour();
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
