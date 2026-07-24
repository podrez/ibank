import cron, { type ScheduledTask } from 'node-cron';
import { syncBankBalances, syncAllStatements } from '../scraper';
import { getEnabledBanks, BankAdapter } from '../banks';
import { logger } from '../logger';
import { getConfig } from '../config/store';
import { getInteractiveAuth } from '../auth/interactive';

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
 * A single cron task fires every INTERVAL minutes, every day (APP_TIMEZONE), and
 * decides per-tick which banks to sync:
 *   - retail banks (adapter `roundTheClock === true`, e.g. iParitet) — always,
 *     since they operate 24/7;
 *   - corporate banks — only within the business window (START_HOUR–END_HOUR,
 *     Mon–Fri + EXTRA_WORKING_DAYS).
 * Using one task (rather than two) avoids both firing on the same minute and
 * contending for the shared browser via the {@link isSyncing} guard.
 */
export function startScheduler(): void {
  const startHour = getStartHour();
  const endHour   = getEndHour();
  const interval  = getInterval();
  const timezone  = getTimezone();
  const extraDays = getExtraWorkingDays();

  const cronExpr = `*/${interval} * * * *`;
  logger.info('Starting scheduler', {
    cronExpr,
    timezone,
    schedule: `Retail (24/7) every ${interval} min; corporate Mon–Fri ${startHour}:00–${endHour}:00 ${timezone} (+ extra working days: ${[...extraDays].join(', ') || 'none'})`,
  });

  syncTask = cron.schedule(cronExpr, () => { runSyncForBanks(banksDueNow()); }, { timezone });
  syncTask.start();

  const initial = banksDueNow();
  if (initial.length > 0) {
    logger.info('Running initial sync', { banks: initial.map((b) => b.id) });
    runSyncForBanks(initial);
  } else {
    logger.info('Outside working hours and no 24/7 banks — waiting for schedule');
  }
}

export function stopScheduler(): void {
  syncTask?.stop();
  syncTask = null;
  logger.info('Scheduler stopped');
}

/**
 * Banks that should sync on the current tick: retail banks always, corporate
 * banks only inside the business window.
 */
function banksDueNow(): BankAdapter[] {
  const inBusinessWindow = isWorkingDay() && isWorkingHour();
  return getEnabledBanks().filter((b) => b.roundTheClock || inBusinessWindow);
}

function isWorkingHour(): boolean {
  const hour = parseInt(new Intl.DateTimeFormat('en', { timeZone: getTimezone(), hour: 'numeric', hour12: false }).format(new Date()));
  return hour >= getStartHour() && hour < getEndHour();
}

/**
 * Run sync for all enabled banks, or a specific bank if bankId is provided.
 * Used by the /api/refresh endpoint — a manual refresh ignores the schedule
 * window and syncs whatever was requested.
 */
export async function runSync(bankId?: string): Promise<void> {
  const banks = getEnabledBanks();
  if (bankId) {
    const bank = banks.find((b) => b.id === bankId);
    if (!bank) {
      logger.warn(`Unknown bank id: ${bankId}`);
      return;
    }
    await runSyncForBanks([bank]);
  } else {
    await runSyncForBanks(banks);
  }
}

/**
 * Sync balances then statements for the given adapters. Adapters are reused
 * across both so statement sync inherits the already-authenticated session.
 * Guarded by {@link isSyncing} so the two scheduler tasks never overlap and
 * contend for the shared browser.
 */
async function runSyncForBanks(banks: BankAdapter[]): Promise<void> {
  // Skip banks whose operator-driven SMS login is mid-flow: syncing calls
  // adapter.login() → resetContext(), which would close the browser context
  // holding the pending SMS page and abort the operator's code entry.
  const list = banks.filter((b) => {
    const awaiting = getInteractiveAuth(b.id)?.status() === 'awaiting_sms';
    if (awaiting) logger.info('Skipping sync — interactive SMS login in progress', { bank: b.id });
    return !awaiting;
  });

  if (list.length === 0) return;
  if (isSyncing) {
    logger.warn('Sync already in progress — skipping', { banks: list.map((b) => b.id) });
    return;
  }
  isSyncing = true;
  try {
    for (const bank of list) {
      await syncBankBalances(bank);
    }
    await syncAllStatements(undefined, undefined, list);
  } finally {
    isSyncing = false;
  }
}
