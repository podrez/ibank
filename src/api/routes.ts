import { Router, Request, Response, NextFunction } from 'express';
import { db, schema } from '../db';
import { desc, eq, and, gte, lte, sql, count } from 'drizzle-orm';
import { runSync, stopScheduler, startScheduler } from '../scheduler';
import { getEnabledBanks, resetEnabledBanks } from '../banks';
import { syncBankStatement, syncAllStatements } from '../scraper';
import { logger } from '../logger';
import { isoToday } from '../utils/dates';
import { getConfig, setConfig, deleteConfig, getAllConfigPublic, isSensitive, ALL_SETTING_KEYS } from '../config/store';
import { closeBrowserIfOpen, hasSavedSession } from '../scraper/browser';
import { getInteractiveAuth, interactiveAuthBanks } from '../auth/interactive';

export const router = Router();

const apiKeyAuth = (req: Request, res: Response, next: NextFunction): void => {
  const apiKey = getConfig('API_KEY');
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
    const [{ value: accountCount }] = await db.select({ value: count() }).from(schema.accounts);

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
      dateTo: dateTo ?? isoToday(),
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
    const todayMinsk = new Intl.DateTimeFormat('sv', { timeZone: getConfig('APP_TIMEZONE') ?? 'Europe/Minsk' }).format(new Date());

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
  const banks = ['alfabank', 'priorbank', 'belveb', 'paritetbank'];
  for (const bank of banks) {
    const key = `${bank.toUpperCase()}_STATEMENT_ACCOUNTS`;
    for (const acc of (getConfig(key) ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      accounts.push({ bank, accountNumber: acc });
    }
  }
  res.json({ accounts });
});

function firstDayOfMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

// ── Interactive SMS authentication ──────────────────────────────────────────────

/**
 * GET /api/auth/:bank/status
 * Reports whether an interactive (SMS) login is in progress and whether a saved
 * session exists. Banks without an interactive flow return supported:false.
 */
router.get('/auth/:bank/status', (req, res) => {
  const bank = req.params.bank;
  const provider = getInteractiveAuth(bank);
  res.json({
    bank,
    supported: !!provider,
    stage: provider ? provider.status() : 'idle',
    hasSession: hasSavedSession(bank),
  });
});

/**
 * POST /api/auth/:bank/start
 * Begin an operator-driven login. Fills credentials and either logs in directly
 * (session still valid) or triggers an SMS and waits for POST .../sms.
 */
router.post('/auth/:bank/start', async (req, res) => {
  const bank = req.params.bank;
  const provider = getInteractiveAuth(bank);
  if (!provider) {
    res.status(404).json({ error: `Bank "${bank}" has no interactive login` });
    return;
  }
  try {
    logger.info('Interactive auth start requested', { bank });
    const result = await provider.start();
    res.json({ bank, ...result });
  } catch (err) {
    logger.error('Interactive auth start failed', { bank, error: (err as Error).message });
    res.status(502).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/auth/:bank/sms   body: { code }
 * Submit the SMS code for a pending interactive login.
 */
router.post('/auth/:bank/sms', async (req, res) => {
  const bank = req.params.bank;
  const provider = getInteractiveAuth(bank);
  if (!provider) {
    res.status(404).json({ error: `Bank "${bank}" has no interactive login` });
    return;
  }
  const code = String((req.body ?? {}).code ?? '').trim();
  if (!code) {
    res.status(400).json({ error: 'code is required' });
    return;
  }
  try {
    logger.info('Interactive auth SMS code submitted', { bank });
    await provider.submitCode(code);
    res.json({ bank, stage: 'logged_in', message: 'Вход выполнен, сессия сохранена.' });
  } catch (err) {
    logger.error('Interactive auth SMS submit failed', { bank, error: (err as Error).message });
    res.status(502).json({ error: (err as Error).message, stage: provider.status() });
  }
});

/**
 * POST /api/auth/:bank/cancel
 * Abort a pending interactive login and release the held browser page.
 */
router.post('/auth/:bank/cancel', async (req, res) => {
  const bank = req.params.bank;
  const provider = getInteractiveAuth(bank);
  if (!provider) {
    res.status(404).json({ error: `Bank "${bank}" has no interactive login` });
    return;
  }
  await provider.cancel().catch(() => null);
  res.json({ bank, stage: 'idle' });
});

/**
 * GET /api/auth
 * List banks that support interactive login, with their current stage/session.
 */
router.get('/auth', (_req, res) => {
  const banks = interactiveAuthBanks().map((bank) => {
    const provider = getInteractiveAuth(bank)!;
    return { bank, stage: provider.status(), hasSession: hasSavedSession(bank) };
  });
  res.json({ banks });
});

// ── Settings endpoints ─────────────────────────────────────────────────────────

/**
 * GET /api/settings
 * Returns all configurable settings. Sensitive values are masked as "***".
 * Also includes read-only runtime keys (API_PORT, DB_PATH).
 */
router.get('/settings', (_req, res) => {
  const cfg = getAllConfigPublic();
  cfg['API_PORT'] = process.env.API_PORT ?? '3000';
  cfg['DB_PATH']  = process.env.DB_PATH  ?? './data/accounts.db';
  res.json(cfg);
});

/**
 * POST /api/settings
 * Accepts a partial settings object. Rules:
 *  - "***"  → skip (unchanged sensitive value)
 *  - ""     → delete from DB (falls back to env)
 *  - other  → save to DB
 * Triggers live reloads as needed.
 */
router.post('/settings', async (req, res) => {
  try {
    const body = req.body as Record<string, string>;

    const BANK_IDS = ['alfabank', 'priorbank', 'belveb', 'paritetbank'] as const;
    const SCHEDULER_KEYS = new Set(['SCHEDULE_START_HOUR', 'SCHEDULE_END_HOUR', 'SCHEDULE_INTERVAL_MINUTES', 'APP_TIMEZONE', 'EXTRA_WORKING_DAYS']);
    const BROWSER_KEYS   = new Set(['HEADLESS', 'BROWSER_TIMEOUT_MS', 'CHROMIUM_EXECUTABLE_PATH']);

    let restartScheduler = false;
    let restartBrowser   = false;
    const banksNeedingReset = new Set<string>();

    for (const [key, rawValue] of Object.entries(body)) {
      // Ignore unknown keys and read-only keys
      if (!ALL_SETTING_KEYS.includes(key as typeof ALL_SETTING_KEYS[number])) continue;

      const value = String(rawValue);

      // "***" sentinel for sensitive fields means "keep as-is"
      if (isSensitive(key) && value === '***') continue;

      const prev = getConfig(key);

      if (value === '') {
        deleteConfig(key);
      } else {
        setConfig(key, value);
      }

      const changed = value !== prev;
      if (!changed) continue;

      if (SCHEDULER_KEYS.has(key)) restartScheduler = true;
      if (BROWSER_KEYS.has(key))   restartBrowser   = true;

      // Detect credential changes per bank
      for (const bankId of BANK_IDS) {
        const upper = bankId.toUpperCase();
        if (key === `${upper}_LOGIN` || key === `${upper}_PASSWORD`) {
          banksNeedingReset.add(bankId);
        }
      }
    }

    // Apply live reloads
    if (restartBrowser) {
      await closeBrowserIfOpen();
    }

    if (banksNeedingReset.size > 0) {
      resetEnabledBanks();
      const banks = getEnabledBanks();
      for (const bankId of banksNeedingReset) {
        const adapter = banks.find((b) => b.id === bankId);
        if (adapter) await adapter.resetSession();
      }
    }

    if (restartScheduler) {
      stopScheduler();
      startScheduler();
    }

    const newLogLevel = getConfig('LOG_LEVEL');
    if (newLogLevel) logger.level = newLogLevel;

    res.json({ ok: true });
  } catch (err) {
    logger.error('POST /settings error', { error: (err as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/settings/accounts
 * All known accounts with statementEnabled flag.
 */
router.get('/settings/accounts', async (_req, res) => {
  try {
    const rows = await db.query.accounts.findMany({
      columns: { bank: true, accountNumber: true, currency: true, name: true },
    });

    const result = rows.map((row) => {
      const key = `${row.bank.toUpperCase()}_STATEMENT_ACCOUNTS`;
      const list = (getConfig(key) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      return { ...row, statementEnabled: list.includes(row.accountNumber) };
    });

    res.json({ accounts: result });
  } catch (err) {
    logger.error('GET /settings/accounts error', { error: (err as Error).message });
    res.status(500).json({ error: 'Internal server error' });
  }
});
