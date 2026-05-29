import { getEnabledBanks, BankAdapter, ScrapedAccount, ScrapedTransaction, StatementRequest } from '../banks';
import { db, schema } from '../db';
import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { logger } from '../logger';
import crypto from 'crypto';
import { notifyStatementChanged } from '../notify/onec';
import { isoToday } from '../utils/dates';

export interface SyncResult {
  bank: string;
  success: boolean;
  accounts: ScrapedAccount[];
  error?: string;
  syncedAt: string;
}

export async function syncAllBanks(banks?: BankAdapter[]): Promise<SyncResult[]> {
  const list = banks ?? getEnabledBanks();
  if (list.length === 0) {
    logger.warn('No banks configured — check your environment variables');
    return [];
  }

  const results: SyncResult[] = [];
  for (const bank of list) {
    const result = await syncBankBalances(bank);
    results.push(result);
  }
  return results;
}

export async function syncBankBalances(bank: BankAdapter): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  logger.info(`Starting balance sync`, { bank: bank.id });

  let logId: number | undefined;

  try {
    const [log] = await db
      .insert(schema.syncLog)
      .values({ bank: bank.id, status: 'running', startedAt })
      .returning({ id: schema.syncLog.id });
    logId = log.id;

    const loggedIn = await bank.isLoggedIn();
    if (!loggedIn) {
      logger.info('Session expired or not started — logging in', { bank: bank.id });
      await bank.login();
    }

    let accounts: ScrapedAccount[];
    try {
      accounts = await bank.scrapeAccounts();
    } catch (scrapeErr) {
      if (needsRelogin(scrapeErr)) {
        logger.warn('Session expired mid-scrape — re-logging in and retrying', { bank: bank.id });
        await bank.login();
        accounts = await bank.scrapeAccounts();
      } else {
        throw scrapeErr;
      }
    }

    if (accounts.length === 0) {
      throw new Error('No accounts found after scraping');
    }

    await persistAccounts(bank.id, accounts);

    const finishedAt = new Date().toISOString();
    await db
      .update(schema.syncLog)
      .set({ status: 'success', accountsFound: accounts.length, finishedAt })
      .where(eq(schema.syncLog.id, logId));

    logger.info('Balance sync completed', { bank: bank.id, count: accounts.length });
    return { bank: bank.id, success: true, accounts, syncedAt: finishedAt };
  } catch (err) {
    const message = (err as Error).message;
    logger.error('Balance sync failed', { bank: bank.id, error: message });

    if (logId) {
      await db
        .update(schema.syncLog)
        .set({ status: 'error', message, finishedAt: new Date().toISOString() })
        .where(eq(schema.syncLog.id, logId))
        .catch(() => null);
    }

    return { bank: bank.id, success: false, accounts: [], error: message, syncedAt: startedAt };
  }
}

// ── Statement sync ────────────────────────────────────────────────────────────

export interface StatementSyncResult {
  bank: string;
  accountNumber: string;
  success: boolean;
  imported: number;
  skipped: number;
  error?: string;
}

/**
 * Sync statements for all accounts listed in ALFABANK_STATEMENT_ACCOUNTS /
 * PRIORBANK_STATEMENT_ACCOUNTS env vars.
 *
 * When dateFrom/dateTo are not specified (scheduled sync):
 *   - dateFrom = last transaction date in DB for that account (or 7 days ago if no history)
 *   - dateTo   = today
 *
 * Explicit dates always override the automatic range.
 */
export async function syncAllStatements(
  dateFrom?: string,
  dateTo?: string,
  banks?: BankAdapter[],
): Promise<StatementSyncResult[]> {
  const today = isoToday();
  const list = banks ?? getEnabledBanks();
  const results: StatementSyncResult[] = [];

  for (const bank of list) {
    if (!bank.scrapeStatement) continue;

    const accountNumbers = getStatementAccounts(bank.id);
    if (accountNumbers.length === 0) {
      logger.debug('No statement accounts configured', { bank: bank.id });
      continue;
    }

    for (const accountNumber of accountNumbers) {
      const from = dateFrom ?? await resolveFromDate(bank.id, accountNumber);
      const to   = dateTo   ?? today;
      logger.info('Statement date range resolved', { bank: bank.id, accountNumber, from, to });
      const result = await syncBankStatement(bank, { accountNumber, dateFrom: from, dateTo: to });
      results.push(result);
    }
  }

  return results;
}

/**
 * Sync statement for a single account. Ensures the bank session is active.
 */
export async function syncBankStatement(
  bank: BankAdapter,
  req: StatementRequest,
): Promise<StatementSyncResult> {
  logger.info('Starting statement sync', { bank: bank.id, account: req.accountNumber, from: req.dateFrom, to: req.dateTo });

  try {
    if (!bank.scrapeStatement) {
      throw new Error(`Bank ${bank.id} does not support statement scraping`);
    }

    const loggedIn = await bank.isLoggedIn();
    if (!loggedIn) {
      logger.info('Session expired or not started — logging in', { bank: bank.id });
      await bank.login();
    }

    let transactions: ScrapedTransaction[];
    try {
      transactions = await bank.scrapeStatement(req);
    } catch (scrapeErr) {
      if (needsRelogin(scrapeErr)) {
        logger.warn('Session expired mid-scrape — re-logging in and retrying', { bank: bank.id });
        await bank.login();
        transactions = await bank.scrapeStatement(req);
      } else {
        throw scrapeErr;
      }
    }
    logger.info('Statement scraped', { bank: bank.id, account: req.accountNumber, count: transactions.length });

    const { imported, skipped } = await persistTransactions(bank.id, req.accountNumber, transactions);
    logger.info('Statement persisted', { bank: bank.id, account: req.accountNumber, imported, skipped });

    if (imported > 0) {
      await notifyStatementChanged(bank.id, req.accountNumber);
    }

    return { bank: bank.id, accountNumber: req.accountNumber, success: true, imported, skipped };
  } catch (err) {
    const message = (err as Error).message;
    logger.error('Statement sync failed', { bank: bank.id, account: req.accountNumber, error: message });
    return { bank: bank.id, accountNumber: req.accountNumber, success: false, imported: 0, skipped: 0, error: message };
  }
}

async function persistTransactions(
  bankId: string,
  accountNumber: string,
  scraped: ScrapedTransaction[],
): Promise<{ imported: number; skipped: number }> {
  if (scraped.length === 0) return { imported: 0, skipped: 0 };

  const rows = scraped.map((tx) => ({
    bank: bankId,
    accountNumber,
    transactionDate: tx.transactionDate,
    reference: tx.reference ?? null,
    description: tx.description,
    debit: tx.debit ?? null,
    credit: tx.credit ?? null,
    currency: tx.currency,
    counterpartyUnp: tx.counterpartyUnp ?? null,
    counterpartyName: tx.counterpartyName ?? null,
    counterpartyAccount: tx.counterpartyAccount ?? null,
    operationCode: tx.operationCode ?? null,
    txKey: computeTxKey(tx),
  }));

  // Single INSERT OR IGNORE — unique index on (bank, accountNumber, transactionDate, txKey)
  const inserted = await db
    .insert(schema.transactions)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: schema.transactions.id });

  const imported = inserted.length;
  const skipped = rows.length - imported;
  return { imported, skipped };
}

/**
 * Compute a stable deduplication key for a transaction.
 * Uses reference when available; falls back to a hash of (description, debit, credit).
 */
function computeTxKey(tx: ScrapedTransaction): string {
  if (tx.reference) return tx.reference;
  const raw = [tx.description, tx.debit ?? '', tx.credit ?? ''].join('|');
  return crypto.createHash('md5').update(raw).digest('hex').slice(0, 16);
}

/**
 * Parse ALFABANK_STATEMENT_ACCOUNTS or PRIORBANK_STATEMENT_ACCOUNTS env var
 * into an array of account numbers.
 */
function getStatementAccounts(bankId: string): string[] {
  const key = `${bankId.toUpperCase()}_STATEMENT_ACCOUNTS`;
  const raw = process.env[key] ?? '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}


/**
 * Determine the start date for a statement sync when no explicit date is given.
 * Uses the most recent transaction date already in the DB for this account.
 * Falls back to 7 days ago if no transactions exist yet.
 */
async function resolveFromDate(bankId: string, accountNumber: string): Promise<string> {
  const last = await db.query.transactions.findFirst({
    where: and(
      eq(schema.transactions.bank, bankId),
      eq(schema.transactions.accountNumber, accountNumber),
    ),
    orderBy: [desc(schema.transactions.transactionDate)],
    columns: { transactionDate: true },
  });

  if (last) {
    logger.debug('resolveFromDate: last transaction found', {
      bank: bankId, accountNumber, lastDate: last.transactionDate,
    });
    return last.transactionDate;
  }

  // No history — load last 7 days
  const d = new Date();
  d.setDate(d.getDate() - 7);
  const fallback = d.toISOString().slice(0, 10);
  logger.debug('resolveFromDate: no history, falling back', { bank: bankId, accountNumber, fallback });
  return fallback;
}

// ── Session-expiry / browser-stuck detection ──────────────────────────────────

function needsRelogin(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  // Session expired (redirect to login) OR Playwright navigation/page timeout
  return /session.?expired|SessionTimeout/i.test(msg) ||
         /Timeout \d+ms exceeded|Navigation timeout|net::ERR_/i.test(msg);
}

// ── Account persistence ───────────────────────────────────────────────────────

async function persistAccounts(bankId: string, scraped: ScrapedAccount[]): Promise<void> {
  if (scraped.length === 0) return;
  const now = new Date().toISOString();

  // Identify new accounts before upsert so we can log them
  const existing = await db
    .select({ accountNumber: schema.accounts.accountNumber })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.bank, bankId),
        inArray(schema.accounts.accountNumber, scraped.map((a) => a.accountNumber)),
      ),
    );
  const knownSet = new Set(existing.map((r) => r.accountNumber));

  // Single INSERT … ON CONFLICT DO UPDATE (upsert all accounts in one query)
  await db
    .insert(schema.accounts)
    .values(
      scraped.map((item) => ({
        bank: bankId,
        accountNumber: item.accountNumber,
        currency: item.currency,
        name: item.name,
        balance: item.balance,
        available: item.available,
        balanceUpdatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [schema.accounts.bank, schema.accounts.accountNumber],
      set: {
        currency: sql`excluded.currency`,
        // Keep existing name if scraper returned empty string
        name: sql`COALESCE(NULLIF(excluded.name, ''), ${schema.accounts.name})`,
        balance: sql`excluded.balance`,
        available: sql`excluded.available`,
        balanceUpdatedAt: sql`excluded.balance_updated_at`,
      },
    });

  for (const item of scraped) {
    if (!knownSet.has(item.accountNumber)) {
      logger.info('New account registered', {
        bank: bankId,
        accountNumber: item.accountNumber,
        currency: item.currency,
      });
    }
  }
}
