import { Page } from 'playwright';
import { ScrapedTransaction, StatementRequest } from '../types';
import { logger } from '../../logger';
import fs from 'fs';

const API_BASE = '/corporate/web-api/v1';
const DEBUG_DIR = './data/debug';

interface RawTransaction {
  bris_id?: string | number;
  date?: string;
  corr_name?: string;
  description?: string;
  sum_credit?: number;
  sum_debit?: number;
  doc_num?: string;
  currency_alt?: string;
  currency?: string;
  corr_bank?: string;
  corr_unn?: string;
}

interface ParitetAccount {
  id: number | string;
  number: string;
  currency?: string;
}

export async function scrapeStatement(
  page: Page,
  req: StatementRequest,
): Promise<ScrapedTransaction[]> {
  logger.info('[paritetbank:stmt] ═══ Starting statement scrape ═══', {
    account: req.accountNumber, from: req.dateFrom, to: req.dateTo,
  });

  const snap = makeSnapper(page, req.accountNumber);

  // 1. Resolve internal account ID from account number
  const accountId = await resolveAccountId(page, req.accountNumber);
  logger.info('[paritetbank:stmt] Resolved account id', { accountId });

  // 2. Fetch transaction history
  logger.info('[paritetbank:stmt] Fetching transaction history');
  const historyData = await page.evaluate(
    async (params: { apiBase: string; id: number | string; dateFrom: string; dateTo: string }) => {
      try {
        const res = await fetch(`${params.apiBase}/accounts/getAccountHistoryById`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: JSON.stringify({ account_id: params.id, dateFrom: params.dateFrom, dateTo: params.dateTo }),
          credentials: 'same-origin',
        });
        return await res.json() as unknown;
      } catch { return null; }
    },
    {
      apiBase: API_BASE,
      id: accountId,
      dateFrom: isoToDMY(req.dateFrom),
      dateTo: isoToDMY(req.dateTo),
    },
  );

  if (process.env.DEBUG_SCREENSHOTS === 'true') {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const safe = req.accountNumber.replace(/[^A-Z0-9]/gi, '_');
    fs.writeFileSync(
      `${DEBUG_DIR}/paritetbank-stmt-${safe}-response.json`,
      JSON.stringify(historyData, null, 2),
    );
  }

  await snap('01-result');

  const raw = historyData as Record<string, unknown> | null;
  const documents: RawTransaction[] =
    (raw?.objects as Record<string, unknown>)?.documents as RawTransaction[] ?? [];

  if (!Array.isArray(documents) || documents.length === 0) {
    logger.info('[paritetbank:stmt] No transactions in range', {
      account: req.accountNumber, from: req.dateFrom, to: req.dateTo,
    });
    return [];
  }

  const transactions = documents.map(parseTransaction).filter((t): t is ScrapedTransaction => t !== null);
  logger.info('[paritetbank:stmt] Transactions extracted', { count: transactions.length });
  return transactions;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolveAccountId(page: Page, accountNumber: string): Promise<number | string> {
  const data = await page.evaluate(async (apiBase: string) => {
    try {
      const res = await fetch(`${apiBase}/accounts/getAccounts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'same-origin',
      });
      return await res.json() as unknown;
    } catch { return null; }
  }, API_BASE);

  const raw = data as Record<string, unknown> | null;
  const accounts: ParitetAccount[] =
    (raw?.objects as Record<string, unknown>)?.accounts as ParitetAccount[] ?? [];

  if (!Array.isArray(accounts)) {
    throw new Error('[paritetbank:stmt] getAccounts returned unexpected structure');
  }

  // Strip spaces/formatting for loose matching
  const normalise = (s: string) => s.replace(/\s/g, '').toUpperCase();
  const target = normalise(accountNumber);
  const found = accounts.find((a) => normalise(a.number ?? '') === target);

  if (!found) {
    throw new Error(
      `[paritetbank:stmt] Account ${accountNumber} not found in getAccounts response. ` +
      `Available: ${accounts.map((a) => a.number).join(', ')}`,
    );
  }

  return found.id;
}

function parseTransaction(t: RawTransaction): ScrapedTransaction | null {
  const transactionDate = parseDate(t.date ?? '');
  if (!transactionDate) return null;

  const credit = t.sum_credit && t.sum_credit > 0 ? t.sum_credit : undefined;
  const debit = t.sum_debit && t.sum_debit > 0 ? t.sum_debit : undefined;

  return {
    transactionDate,
    reference: t.doc_num || undefined,
    description: t.description || '—',
    debit,
    credit,
    currency: t.currency_alt || t.currency || 'BYN',
    counterpartyName: t.corr_name || undefined,
    counterpartyUnp: t.corr_unn || undefined,
  };
}

function isoToDMY(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function parseDate(raw: string): string | null {
  if (!raw) return null;
  // ISO yyyy-MM-dd
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  // DD.MM.YYYY
  const dmy = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  // Unix timestamp (ms or s)
  if (/^\d{10,13}$/.test(raw)) {
    const ts = Number(raw);
    const d = new Date(ts > 9999999999 ? ts : ts * 1000);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

function makeSnapper(page: Page, accountNumber: string) {
  return async (label: string): Promise<void> => {
    if (process.env.DEBUG_SCREENSHOTS !== 'true') return;
    try {
      if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
      const safe = accountNumber.replace(/[^A-Z0-9]/gi, '_');
      const file = `paritetbank-stmt-${safe}-${label}`;
      await page.screenshot({ path: `${DEBUG_DIR}/${file}.png`, fullPage: true }).catch(() => null);
      fs.writeFileSync(`${DEBUG_DIR}/${file}.html`, await page.content().catch(() => ''));
    } catch { /* ignore */ }
  };
}
