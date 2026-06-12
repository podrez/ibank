import { Page } from 'playwright';
import { ScrapedAccount } from '../types';
import { logger } from '../../logger';
import fs from 'fs';
import { getConfig } from '../../config/store';

const API_BASE = '/corporate/web-api/v1';

interface ParitetAccount {
  id: number | string;
  number: string;
  currency: string;
  sum?: number;
  debet?: number;
  balance?: number;
  typeText?: string;
  type?: string;
  status?: string;
  name?: string;
}

export async function scrapeAccounts(page: Page): Promise<ScrapedAccount[]> {
  logger.info('[paritetbank] Fetching accounts via API');

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

  if (getConfig('DEBUG_SCREENSHOTS') === 'true') {
    const dir = './data/debug';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/paritetbank-accounts-response.json`, JSON.stringify(data, null, 2));
    logger.info('[paritetbank] Accounts API response saved to ./data/debug/');
  }

  const raw = data as Record<string, unknown> | null;
  const accounts: ParitetAccount[] = (raw?.objects as Record<string, unknown>)?.accounts as ParitetAccount[] ?? [];

  if (!Array.isArray(accounts) || accounts.length === 0) {
    logger.warn('[paritetbank] getAccounts returned empty array. Set DEBUG_SCREENSHOTS=true to inspect the response.');
    return [];
  }

  logger.info('[paritetbank] Accounts fetched', { count: accounts.length });

  return accounts.map((a) => {
    const balance = parseFloat(String(a.sum ?? a.balance ?? '0')) || 0;
    return {
      accountNumber: a.number,
      currency: a.currency,
      name: a.typeText || a.number,
      balance,
      available: balance,
    };
  });
}
