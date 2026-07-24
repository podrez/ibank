import { Page } from 'playwright';
import { ScrapedAccount } from '../types';
import { logger } from '../../logger';
import fs from 'fs';
import { getConfig } from '../../config/store';
import { CORE_API, apiCallWithRetry, waitForSessionToken, normaliseCurrency } from './api';

const PRODUCTS_PATH = `${CORE_API}/product/get-products?getCreditDetail=false`;

// Response shapes (verified against a live get-products payload). Card balances
// live inside cardAccount[].cards[]; current accounts carry `balanceAmount`.
interface ParitetCard {
  balance?: number;
  currency?: string;
  cardNumberMasked?: string;
  name?: string;
  isMainPayProduct?: boolean;
}
interface CardAccount {
  accountNumber?: string;
  ibanNum?: string;
  currency?: string;
  productName?: string;
  contractNumber?: string;
  cards?: ParitetCard[];
}
interface CurrentAccount {
  accountNumber?: string;
  ibanNum?: string;
  currency?: string;
  productName?: string;
  balanceAmount?: number;
}
interface ProductsResponse {
  cardAccount?: CardAccount[];
  currentAccount?: CurrentAccount[];
}

export async function scrapeAccounts(page: Page): Promise<ScrapedAccount[]> {
  logger.info('[iparitet] Fetching products via API');

  const token = await waitForSessionToken(page);
  if (!token) {
    throw new Error('[iparitet] SessionTimeout — no session token found (re-login required)');
  }

  const { ok, status, data, error } = await apiCallWithRetry(page, { path: PRODUCTS_PATH, method: 'GET', token });

  if (getConfig('DEBUG_SCREENSHOTS') === 'true') {
    const dir = './data/debug';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/iparitet-accounts-response.json`, JSON.stringify(data, null, 2));
    logger.info('[iparitet] Products API response saved to ./data/debug/');
  }

  if (!ok) {
    if (status === 401) throw new Error('[iparitet] SessionTimeout — products API returned 401');
    throw new Error(`[iparitet] get-products failed — ${error ?? `status ${status}`}`);
  }

  const resp = (data ?? {}) as ProductsResponse;
  const accounts: ScrapedAccount[] = [];

  for (const acc of resp.cardAccount ?? []) {
    const scraped = cardAccountToScraped(acc);
    if (scraped) accounts.push(scraped);
  }
  for (const acc of resp.currentAccount ?? []) {
    const scraped = currentAccountToScraped(acc);
    if (scraped) accounts.push(scraped);
  }

  if (accounts.length === 0) {
    logger.warn('[iparitet] get-products returned no card/current accounts. Set DEBUG_SCREENSHOTS=true to inspect the response.');
    return [];
  }

  logger.info('[iparitet] Products fetched', { count: accounts.length });
  return accounts;
}

/**
 * One card account = one account (счёт) behind the card(s). Cards on the same
 * account share its balance, so take the main card's balance (or the first).
 */
function cardAccountToScraped(acc: CardAccount): ScrapedAccount | null {
  const accountNumber = (acc.accountNumber || acc.ibanNum || acc.contractNumber || '').trim();
  if (!accountNumber) return null;

  const cards = acc.cards ?? [];
  const primary = cards.find((c) => c.isMainPayProduct) ?? cards[0];
  const balance = Number(primary?.balance ?? 0) || 0;
  const currency = normaliseCurrency(primary?.currency ?? acc.currency);
  const cardLabel = primary?.cardNumberMasked ? ` (${primary.cardNumberMasked})` : '';

  return {
    accountNumber,
    currency,
    name: `${acc.productName || primary?.name || 'Карта'}${cardLabel}`,
    balance,
    available: balance,
  };
}

function currentAccountToScraped(acc: CurrentAccount): ScrapedAccount | null {
  const accountNumber = (acc.accountNumber || acc.ibanNum || '').trim();
  if (!accountNumber) return null;

  const balance = Number(acc.balanceAmount ?? 0) || 0;
  return {
    accountNumber,
    currency: normaliseCurrency(acc.currency),
    name: acc.productName || accountNumber,
    balance,
    available: balance,
  };
}
