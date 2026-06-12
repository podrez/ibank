import { Page } from 'playwright';
import { ScrapedAccount } from '../types';
import { logger } from '../../logger';
import fs from 'fs';
import { getConfig } from '../../config/store';

/**
 * Scrape account balances from the Priorbank iBank dashboard.
 * Strategy 1: intercept XHR/fetch responses that contain account JSON.
 * Strategy 2: DOM scraping of account cards.
 *
 * If scraping fails, set DEBUG_SCREENSHOTS=true and inspect
 * ./data/debug/priorbank-dashboard.html to identify the correct selectors.
 */
const CABINET_URL = 'https://www.ibank.priorbank.by/v1/cabinet/';

export async function scrapeAccounts(page: Page): Promise<ScrapedAccount[]> {
  if (!/\/v1\/cabinet\/?$/i.test(page.url())) {
    await page.goto(CABINET_URL, { waitUntil: 'domcontentloaded' });
  }

  logger.info('[priorbank] Scraping account balances', { url: page.url() });

  const apiAccounts = await tryApiIntercept(page);
  if (apiAccounts && apiAccounts.length > 0) {
    logger.info('[priorbank] Accounts fetched via API intercept', { count: apiAccounts.length });
    return apiAccounts;
  }

  logger.info('[priorbank] API intercept yielded nothing, falling back to DOM scraping');
  return domScrape(page);
}

// ── Strategy 1: API intercept ─────────────────────────────────────────────────

async function tryApiIntercept(page: Page): Promise<ScrapedAccount[] | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      page.removeAllListeners('response');
      resolve(null);
    }, 12_000);

    page.on('response', async (response) => {
      const url = response.url();
      const isCandidate =
        url.includes('account') ||
        url.includes('Account') ||
        url.includes('balance') ||
        url.includes('Balance') ||
        url.includes('product') ||
        url.includes('Product') ||
        url.includes('card') ||
        url.includes('Card');

      if (!isCandidate || !response.ok()) return;

      const contentType = response.headers()['content-type'] ?? '';
      if (!contentType.includes('json')) return;

      try {
        const json = await response.json();
        logger.debug('[priorbank] Candidate API response', {
          url,
          preview: JSON.stringify(json).slice(0, 500),
        });
        const accounts = parseApiResponse(json);
        if (accounts && accounts.length > 0) {
          clearTimeout(timer);
          page.removeAllListeners('response');
          resolve(accounts);
        }
      } catch { /* not parseable */ }
    });

    page.reload({ waitUntil: 'networkidle' }).catch(() => resolve(null));
  });
}

function parseApiResponse(json: unknown): ScrapedAccount[] | null {
  if (!json || typeof json !== 'object') return null;

  let list: unknown[] | null = null;
  if (Array.isArray(json)) {
    list = json;
  } else {
    const obj = json as Record<string, unknown>;
    for (const key of [
      'accounts', 'Accounts', 'data', 'Data', 'items', 'Items',
      'result', 'Result', 'cards', 'Cards', 'products', 'Products',
    ]) {
      if (Array.isArray(obj[key])) { list = obj[key] as unknown[]; break; }
    }
  }
  if (!list || list.length === 0) return null;

  const result: ScrapedAccount[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;

    const accountNumber = str(a, [
      'accountNumber', 'AccountNumber', 'account', 'Account',
      'iban', 'Iban', 'IBAN', 'number', 'Number', 'cardNumber', 'CardNumber',
    ]);
    const currency = str(a, [
      'CurrencyText', 'currencyText',
      'currency', 'Currency', 'currencyCode', 'CurrencyCode',
      'iso', 'Iso', 'currencyIso', 'CurrencyIso',
    ]);
    const balance = num(a, [
      'balance', 'Balance', 'amount', 'Amount', 'currentBalance', 'CurrentBalance',
      'accountBalance', 'AccountBalance',
      'AvailableBalance', 'availableBalance',
    ]);
    const available = numOrNull(a, [
      'available', 'Available', 'availableBalance', 'AvailableBalance',
      'availableAmount', 'AvailableAmount',
    ]);
    const name = str(a, [
      'name', 'Name', 'title', 'Title', 'description', 'Description',
      'alias', 'Alias', 'productName', 'ProductName',
    ]);

    if (!accountNumber || !currency || balance === null) continue;
    result.push({ accountNumber, currency, name, balance, available });
  }

  return result.length > 0 ? result : null;
}

// ── Strategy 2: DOM scraping ──────────────────────────────────────────────────

async function domScrape(page: Page): Promise<ScrapedAccount[]> {
  await page.waitForLoadState('networkidle');

  // Try progressively broader selectors for account/card rows
  const cardSelectors = [
    '[class*="account-card"]',
    '[class*="AccountCard"]',
    '[class*="account-item"]',
    '[class*="AccountItem"]',
    '[class*="account__item"]',
    '[class*="card-item"]',
    '[class*="CardItem"]',
    '[class*="product-card"]',
    '[class*="ProductCard"]',
    '[data-test*="account"]',
    '[data-qa*="account"]',
    '.account',
    '.accounts > *',
    '.accounts-list > *',
    'table tr',
  ];

  // SPA may continue rendering after networkidle; wait for any known card selector
  await page.waitForSelector(cardSelectors.join(', '), { timeout: 10_000 }).catch(() => null);

  if (getConfig('DEBUG_SCREENSHOTS') === 'true') {
    const dir = './data/debug';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/priorbank-dashboard.html`, await page.content());
    await page.screenshot({ path: `${dir}/priorbank-dashboard.png`, fullPage: true }).catch(() => null);
    logger.info('[priorbank] Dashboard snapshot saved to ./data/debug/');
  }

  for (const sel of cardSelectors) {
    const cards = await page.locator(sel).all();
    if (cards.length === 0) continue;

    logger.debug(`[priorbank] Found ${cards.length} potential account cards with: ${sel}`);
    const results: ScrapedAccount[] = [];
    for (const card of cards) {
      const text = await card.innerText().catch(() => '');
      const parsed = parseCardText(text);
      if (parsed) results.push(parsed);
    }
    if (results.length > 0) return results;
  }

  throw new Error(
    '[priorbank] Could not find account data on the dashboard. ' +
    'Set DEBUG_SCREENSHOTS=true and inspect ./data/debug/priorbank-dashboard.html.',
  );
}

function parseCardText(text: string): ScrapedAccount | null {
  if (!text.trim()) return null;

  // Cards use tab-separated fields: name TAB IBAN TAB balance TAB currency
  // Split on any combination of tabs/newlines to process fields individually.
  // This avoids greedy cross-field matching that would swallow account number digits.
  const parts = text.split(/[\t\n\r]+/).map((s) => s.trim()).filter(Boolean);

  const ibanMatch = text.match(/BY\d{2}[A-Z0-9]{4}\d{16,20}/i);
  const numMatch = text.match(/\b\d{20,}\b/) ?? text.match(/\b\d{13,}\b/);
  const accountNumber = ibanMatch?.[0] ?? numMatch?.[0] ?? '';

  const ibanRe = /^BY\d{2}[A-Z0-9]{4}\d{16,}/i;
  const currencyRe = /^(BYN|USD|EUR|RUB|CNY)$/i;
  // Balance field: optional leading minus, digits/spaces, decimal separator, 2 digits
  const balanceRe = /^-?[\d\s ]+[.,]\d{2}$/;
  // Balance with inline currency: "28 073.49 BYN"
  const inlineRe = /^(-?[\d\s ]+[.,]\d{2})\s+(BYN|USD|EUR|RUB|CNY)$/i;
  const availRe = /[Дд]оступно[:\s]*(-?[\d\s ]+[.,]\d{2})(?:\s*(BYN|USD|EUR|RUB|CNY))?/i;

  let currency = '';
  let balance: number | null = null;
  let available: number | null = null;
  let name = '';

  for (const p of parts) {
    if (ibanRe.test(p)) continue;

    const availM = availRe.exec(p);
    if (availM) {
      available = parseFloat(availM[1].replace(/[\s ]/g, '').replace(',', '.'));
      if (availM[2] && !currency) currency = availM[2].toUpperCase();
      continue;
    }

    const inlineM = inlineRe.exec(p);
    if (inlineM) {
      if (balance === null) balance = parseFloat(inlineM[1].replace(/[\s ]/g, '').replace(',', '.'));
      if (!currency) currency = inlineM[2].toUpperCase();
      continue;
    }

    if (currencyRe.test(p)) {
      if (!currency) currency = p.toUpperCase();
      continue;
    }

    if (balanceRe.test(p)) {
      if (balance === null) balance = parseFloat(p.replace(/[\s ]/g, '').replace(',', '.'));
      continue;
    }

    if (!name) name = p;
  }

  if (!currency) {
    const m = text.match(/\b(BYN|USD|EUR|RUB|CNY)\b/i);
    if (m) currency = m[1].toUpperCase();
  }

  if (!accountNumber || !currency || balance === null || isNaN(balance)) return null;
  return { accountNumber, currency, name, balance, available };
}

// ── Tiny helpers ──────────────────────────────────────────────────────────────

function str(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) if (obj[k] != null) return String(obj[k]);
  return '';
}

function num(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = parseFloat(String(obj[k] ?? ''));
    if (!isNaN(v)) return v;
  }
  return null;
}

function numOrNull(obj: Record<string, unknown>, keys: string[]): number | null {
  return num(obj, keys);
}
