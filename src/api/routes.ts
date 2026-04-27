import { Router, Request, Response, NextFunction } from 'express';
import { db, schema } from '../db';
import { desc, eq, and, gte, lte, sql } from 'drizzle-orm';
import { runSync } from '../scheduler';
import { getEnabledBanks } from '../banks';
import { syncBankStatement, syncAllStatements } from '../scraper';
import { logger } from '../logger';

export const router = Router();

const apiKeyAuth = (req: Request, res: Response, next: NextFunction): void => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) { next(); return; }

  const provided =
    req.headers['x-api-key'] ??
    req.headers['authorization']?.replace(/^Bearer\s+/i, '');

  if (provided !== apiKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
};

router.use(apiKeyAuth);

/**
 * GET /api/accounts[?bank=alfabank|priorbank]
 * All accounts with current balance. Primary endpoint for 1C.
 */
router.get('/accounts', async (req, res) => {
  try {
    const bankFilter = req.query['bank'] as string | undefined;

    const accounts = bankFilter
      ? await db.query.accounts.findMany({
          where: eq(schema.accounts.bank, bankFilter),
          orderBy: (a) => a.accountNumber,
        })
      : await db.query.accounts.findMany({
          orderBy: (a) => a.accountNumber,
        });

    res.json({ accounts, count: accounts.length });
  } catch (err) {
    logger.error('GET /accounts error', { error: (err as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/status
 * Service status and last sync info per bank.
 */
router.get('/status', async (_req, res) => {
  try {
    const lastSync = await db.query.syncLog.findFirst({
      orderBy: [desc(schema.syncLog.startedAt)],
    });
    const accountCount = await db.query.accounts.findMany().then((r) => r.length);

    res.json({
      status: 'ok',
      lastSync: lastSync ?? null,
      accountsTracked: accountCount,
      serverTime: new Date().toISOString(),
    });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/refresh[?bank=alfabank|priorbank]
 * Force immediate sync. Optionally for a specific bank only.
 */
router.post('/refresh', async (req, res) => {
  const bankFilter = req.query['bank'] as string | undefined;
  logger.info('Manual refresh triggered via API', { bank: bankFilter ?? 'all' });
  runSync(bankFilter).catch((err) => logger.error('Manual refresh error', { error: err.message }));
  res.json({ message: 'Refresh started', bank: bankFilter ?? 'all' });
});

/**
 * GET /api/sync-log[?bank=alfabank|priorbank]
 * Last 20 sync log entries.
 */
router.get('/sync-log', async (req, res) => {
  try {
    const bankFilter = req.query['bank'] as string | undefined;

    const logs = bankFilter
      ? await db.query.syncLog.findMany({
          where: eq(schema.syncLog.bank, bankFilter),
          orderBy: [desc(schema.syncLog.startedAt)],
          limit: 20,
        })
      : await db.query.syncLog.findMany({
          orderBy: [desc(schema.syncLog.startedAt)],
          limit: 20,
        });

    res.json({ logs });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/statements?bank=&account=&from=yyyy-MM-dd&to=yyyy-MM-dd&limit=100
 * Returns stored transactions. All query params are optional.
 */
router.get('/statements', async (req, res) => {
  try {
    const bankFilter = req.query['bank'] as string | undefined;
    const accountFilter = req.query['account'] as string | undefined;
    const fromFilter = req.query['from'] as string | undefined;
    const toFilter = req.query['to'] as string | undefined;
    const limit = Math.min(parseInt(String(req.query['limit'] ?? '500'), 10) || 500, 2000);

    const conditions = [];
    if (bankFilter) conditions.push(eq(schema.transactions.bank, bankFilter));
    if (accountFilter) conditions.push(eq(schema.transactions.accountNumber, accountFilter));
    if (fromFilter) conditions.push(gte(schema.transactions.transactionDate, fromFilter));
    if (toFilter) conditions.push(lte(schema.transactions.transactionDate, toFilter));

    const rows = await db.query.transactions.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      orderBy: [desc(schema.transactions.transactionDate), desc(schema.transactions.id)],
      limit,
    });

    res.json({ transactions: rows, count: rows.length });
  } catch (err) {
    logger.error('GET /statements error', { error: (err as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/statements/refresh
 * Trigger statement download. Body (JSON, all optional):
 *   { bank, account, dateFrom, dateTo }
 * If bank/account omitted — syncs all configured statement accounts.
 * Returns immediately; sync runs in the background.
 */
router.post('/statements/refresh', async (req, res) => {
  const { bank: bankId, account, dateFrom, dateTo } = req.body ?? {};

  if (bankId && account) {
    // Single account refresh
    const banks = getEnabledBanks();
    const bank = banks.find((b) => b.id === bankId);
    if (!bank) {
      res.status(404).json({ error: `Bank "${bankId}" not found or not enabled` });
      return;
    }
    if (!bank.scrapeStatement) {
      res.status(422).json({ error: `Bank "${bankId}" does not support statement scraping` });
      return;
    }

    logger.info('Manual statement refresh triggered', { bank: bankId, account, dateFrom, dateTo });
    syncBankStatement(bank, {
      accountNumber: account,
      dateFrom: dateFrom ?? firstDayOfMonth(),
      dateTo: dateTo ?? today(),
    }).catch((err) => logger.error('Statement refresh error', { error: err.message }));

    res.json({ message: 'Statement refresh started', bank: bankId, account });
  } else {
    // All configured statement accounts
    logger.info('Manual statement refresh triggered for all accounts');
    syncAllStatements(dateFrom, dateTo)
      .catch((err) => logger.error('Statement refresh error', { error: err.message }));
    res.json({ message: 'Statement refresh started for all configured accounts' });
  }
});

/**
 * GET /api/today-totals
 * Returns today's credit/debit totals per account (Minsk time, UTC+3).
 */
router.get('/today-totals', async (_req, res) => {
  try {
    const todayMinsk = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);

    const rows = await db
      .select({
        bank: schema.transactions.bank,
        accountNumber: schema.transactions.accountNumber,
        currency: schema.transactions.currency,
        totalCredit: sql<number>`COALESCE(SUM(${schema.transactions.credit}), 0)`,
        totalDebit: sql<number>`COALESCE(SUM(${schema.transactions.debit}), 0)`,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.transactionDate, todayMinsk))
      .groupBy(
        schema.transactions.bank,
        schema.transactions.accountNumber,
        schema.transactions.currency,
      );

    res.json({ totals: rows, date: todayMinsk });
  } catch (err) {
    logger.error('GET /today-totals error', { error: (err as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/statement-accounts
 * Returns list of accounts configured for statement syncing (from env vars).
 */
router.get('/statement-accounts', (_req, res) => {
  const accounts: { bank: string; accountNumber: string }[] = [];

  for (const acc of (process.env.ALFABANK_STATEMENT_ACCOUNTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    accounts.push({ bank: 'alfabank', accountNumber: acc });
  }
  for (const acc of (process.env.PRIORBANK_STATEMENT_ACCOUNTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    accounts.push({ bank: 'priorbank', accountNumber: acc });
  }

  res.json({ accounts });
});

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function firstDayOfMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
