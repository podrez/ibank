import { Page } from 'playwright';
import fs from 'fs';
import { ScrapedTransaction, StatementRequest } from '../types';
import { logger } from '../../logger';
import { parseDate } from '../../utils/dates';
import { getConfig } from '../../config/store';

const BASE_URL = 'https://www.ibank.priorbank.by';

/**
 * Statements live in Priorbank's NEW cabinet (React/Ant Design, `/Cabinet/*`),
 * which exposes a JSON API under `/v2/`. The old Kendo UI cabinet (`/v1/`) still
 * serves the dashboard — that is where balances are scraped from — but its
 * statement page (`/v1/Cabinet/101`) is gone: the id no longer resolves, the bank
 * quietly serves the desktop instead, and scraping yielded 0 rows every cycle.
 */
const CABINET_URL = `${BASE_URL}/Cabinet/1`;
const DEBUG_DIR = './data/debug';

/** Minsk is UTC+3 year-round (no DST); the API expects an explicit offset. */
const TZ_OFFSET = '+03:00';

interface ApiEnvelope<T> {
  data?: T;
  success?: boolean;
  errorMessage?: string | null;
}

interface AccountLookup {
  accTitle: string;
  accNumber: string;
  currCode: number;
  rubVal: number;
}

interface RawTransaction {
  docId?: string;
  docDate?: string;
  docN?: string;
  /** Bank operation code */
  opr?: string;
  dbAmount?: string;
  crAmount?: string;
  naznText?: string;
  iso?: string;
  corrBankCode?: string;
  corrName?: string;
  unp?: string;
  corrAccount?: string;
}

interface StatementData {
  generalInfo?: Array<{ key: string; value: string }>;
  accountSummaries?: Array<Record<string, string | null>>;
  transactions?: RawTransaction[];
  cacheKey?: string;
}

export async function scrapeStatement(
  page: Page,
  req: StatementRequest,
): Promise<ScrapedTransaction[]> {
  logger.info('[priorbank:statement] ═══ Starting statement scrape ═══', {
    account: req.accountNumber,
    from: req.dateFrom,
    to: req.dateTo,
  });

  await ensureCabinet(page);

  // Step 1: resolve the account descriptor the statement call requires
  const accData = await resolveAccount(page, req.accountNumber);
  logger.debug('[priorbank:statement] Resolved account', { ...accData });

  // Step 2: fetch the statement
  const envelope = await apiCall<StatementData>(page, '/v2/Accounts/GetStatementData', {
    accData,
    dateFrom: `${req.dateFrom}T00:00:00${TZ_OFFSET}`,
    dateTo: `${req.dateTo}T00:00:00${TZ_OFFSET}`,
    // "Дополнительно" checkboxes of the UI form — all on, so the response carries
    // the payment purpose and the counterparty name.
    isNazn: 1,
    isKor: 1,
    isRevaluation: 1,
    sortByAmount: 1,
  });

  saveDebugJson(`priorbank-stmt-${req.accountNumber}-response`, envelope);

  const raw = envelope.data?.transactions ?? [];
  logger.info(`[priorbank:statement] API returned ${raw.length} transactions`);

  return mapTransactions(raw, req.accountNumber);
}

// ── Navigation ────────────────────────────────────────────────────────────────

/**
 * The `/v2/` calls are same-origin fetches carrying the session cookie, so any
 * page on the bank's origin works — but land on the cabinet when we are elsewhere.
 */
async function ensureCabinet(page: Page): Promise<void> {
  if (page.url().startsWith(BASE_URL)) return;

  logger.debug('[priorbank:statement] Navigating to the new cabinet', { url: CABINET_URL });
  await page.goto(CABINET_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.waitForTimeout(1_500);

  if (/\/login/i.test(page.url())) {
    throw new Error('[priorbank:statement] Session expired — redirected to login');
  }
}

// ── API access ────────────────────────────────────────────────────────────────

/**
 * Call a `/v2/` endpoint from inside the page so the browser attaches the session
 * cookie and the SPA's own origin headers. GET when `body` is omitted, else POST.
 */
async function apiCall<T>(page: Page, path: string, body?: unknown): Promise<ApiEnvelope<T>> {
  const result = await page.evaluate(
    async (p: { path: string; body: string | null }) => {
      try {
        const init: RequestInit = {
          method: p.body === null ? 'GET' : 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          credentials: 'same-origin',
        };
        if (p.body !== null) init.body = p.body;
        const res = await fetch(p.path, init);
        return { status: res.status, text: await res.text() };
      } catch (err) {
        return { status: 0, text: `fetch failed: ${String(err)}` };
      }
    },
    { path, body: body === undefined ? null : JSON.stringify(body) },
  );

  if (result.status === 401 || result.status === 403) {
    throw new Error(`[priorbank:statement] Session expired — ${path} returned ${result.status}`);
  }
  if (result.status !== 200) {
    throw new Error(`[priorbank:statement] ${path} returned HTTP ${result.status}: ${result.text.slice(0, 200)}`);
  }

  let envelope: ApiEnvelope<T>;
  try {
    envelope = JSON.parse(result.text) as ApiEnvelope<T>;
  } catch {
    // A login redirect answers 200 with an HTML body — treat that as a dead session
    // rather than as "no data", so the caller re-logs in instead of storing nothing.
    if (/<html|<!doctype/i.test(result.text)) {
      throw new Error(`[priorbank:statement] Session expired — ${path} answered with HTML`);
    }
    throw new Error(`[priorbank:statement] ${path} returned non-JSON: ${result.text.slice(0, 200)}`);
  }

  if (envelope.success === false || envelope.errorMessage) {
    throw new Error(`[priorbank:statement] ${path} failed: ${envelope.errorMessage ?? 'unknown error'}`);
  }

  return envelope;
}

/**
 * `GetStatementData` identifies the account by a descriptor, not by number alone —
 * `currCode`/`rubVal` come from the lookup endpoint.
 */
async function resolveAccount(page: Page, accountNumber: string): Promise<AccountLookup> {
  const envelope = await apiCall<AccountLookup[]>(page, '/v2/Accounts/GetAccountsLookup');
  const accounts = envelope.data ?? [];

  const match = accounts.find((a) => a.accNumber === accountNumber);
  if (!match) {
    throw new Error(
      `[priorbank:statement] Account ${accountNumber} not available. ` +
      `Bank lists: ${accounts.map((a) => a.accNumber).join(', ') || '(none)'}`,
    );
  }

  return { accTitle: match.accTitle, accNumber: match.accNumber, currCode: match.currCode, rubVal: match.rubVal };
}

// ── Mapping ───────────────────────────────────────────────────────────────────

function mapTransactions(raw: RawTransaction[], accountNumber: string): ScrapedTransaction[] {
  const fallbackCurrency = currencyFromAccount(accountNumber);
  const transactions: ScrapedTransaction[] = [];
  let skipped = 0;

  for (const r of raw) {
    const transactionDate = parseDate(r.docDate ?? '');
    if (!transactionDate) { skipped++; continue; }

    const debit = parseAmount(r.dbAmount);
    const credit = parseAmount(r.crAmount);
    if (debit === 0 && credit === 0) { skipped++; continue; }

    transactions.push({
      transactionDate,
      reference: r.docN || r.docId || undefined,
      description: r.naznText ?? '',
      debit: debit > 0 ? debit : undefined,
      credit: credit > 0 ? credit : undefined,
      currency: r.iso || fallbackCurrency,
      counterpartyUnp: r.unp || undefined,
      counterpartyName: r.corrName || undefined,
      counterpartyAccount: r.corrAccount || undefined,
      operationCode: r.opr || undefined,
    });
  }

  logger.info(`[priorbank:statement] Parsed ${transactions.length} transactions, skipped ${skipped}`);
  return transactions;
}

/** Amounts arrive as display strings: "10 931.50" (thousands separated by spaces/NBSP). */
function parseAmount(s: string | undefined): number {
  if (!s) return 0;
  const n = parseFloat(s.replace(/[\s ]/g, '').replace(',', '.'));
  return isNaN(n) ? 0 : Math.abs(n);
}

/** Derive ISO 4217 currency text from Priorbank account number (last 3 digits = numeric code). */
function currencyFromAccount(accountNumber: string): string {
  const map: Record<string, string> = {
    '933': 'BYN', '978': 'EUR', '840': 'USD', '643': 'RUB', '156': 'CNY',
  };
  return map[accountNumber.slice(-3)] ?? 'BYN';
}

function saveDebugJson(name: string, payload: unknown): void {
  if (getConfig('DEBUG_SCREENSHOTS') !== 'true') return;
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.writeFileSync(`${DEBUG_DIR}/${name}.json`, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    logger.debug('[priorbank:statement] Failed to save debug JSON', { error: (err as Error).message });
  }
}
