import { Page } from 'playwright';
import { ScrapedTransaction, StatementRequest } from '../types';
import { logger } from '../../logger';
import fs from 'fs';
import { parseDate } from '../../utils/dates';
import { getConfig } from '../../config/store';
import {
  CORE_API,
  apiCallWithRetry,
  waitForSessionToken,
  normaliseCurrency,
  minskDayStartMs,
  minskDayEndMs,
} from './api';

const PRODUCTS_PATH = `${CORE_API}/product/get-products?getCreditDetail=false`;
const HISTORY_PATH = `${CORE_API}/operation/history/get-operations-history`;
const DEBUG_DIR = './data/debug';

/**
 * A raw operation-history item (verified against a live payload). `amount` sign
 * carries direction: positive = credit (Зачисление), negative = debit (Списание).
 */
interface RawOperation {
  paymentDate?: number | string;
  payName?: string;
  amount?: number;
  currency?: string | number;
  payCode?: string | number;
  operationId?: string | number;
  operationType?: string;
  operationStatus?: string;
  rrn?: string;
  authCode?: string;
  contractNumber?: string;
  operationLocation?: string;
}

interface ProductRef {
  accountNumber?: string;
  ibanNum?: string;
  contractNumber?: string;
  contractNumberHash?: string;
}

export async function scrapeStatement(
  page: Page,
  req: StatementRequest,
): Promise<ScrapedTransaction[]> {
  logger.info('[iparitet:stmt] ═══ Starting statement scrape ═══', {
    account: req.accountNumber, from: req.dateFrom, to: req.dateTo,
  });

  const token = await waitForSessionToken(page);
  if (!token) {
    throw new Error('[iparitet:stmt] SessionTimeout — no session token found (re-login required)');
  }

  const contractNumberHash = await resolveContractHash(page, token, req.accountNumber);
  logger.debug('[iparitet:stmt] Resolved contract hash', { contractNumberHash });

  const body: Record<string, unknown> = {
    dateFrom: minskDayStartMs(req.dateFrom),
    dateTo: minskDayEndMs(req.dateTo),
  };
  if (contractNumberHash) body.contractNumberHash = contractNumberHash;

  const { ok, status, data, error } = await apiCallWithRetry(page, { path: HISTORY_PATH, method: 'POST', token, body });

  if (getConfig('DEBUG_SCREENSHOTS') === 'true') {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const safe = req.accountNumber.replace(/[^A-Z0-9]/gi, '_');
    fs.writeFileSync(`${DEBUG_DIR}/iparitet-stmt-${safe}-response.json`, JSON.stringify(data, null, 2));
  }

  if (!ok) {
    if (status === 401) throw new Error('[iparitet:stmt] SessionTimeout — history API returned 401');
    throw new Error(`[iparitet:stmt] get-operations-history failed — ${error ?? `status ${status}`}`);
  }

  const raw = (data ?? {}) as Record<string, unknown>;
  const operations = (raw.operationHistory as RawOperation[]) ?? [];

  if (!Array.isArray(operations) || operations.length === 0) {
    logger.info('[iparitet:stmt] No transactions in range', {
      account: req.accountNumber, from: req.dateFrom, to: req.dateTo,
    });
    return [];
  }

  const settled = operations.filter(isSettled);
  const pending = operations.length - settled.length;
  if (pending > 0) {
    logger.info('[iparitet:stmt] Pending (authorisation-only) operations skipped', {
      account: req.accountNumber,
      pending,
      samples: operations.filter((op) => !isSettled(op)).slice(0, 5).map((op) => ({
        payName: op.payName, amount: op.amount, rrn: op.rrn, status: op.operationStatus,
      })),
    });
  }

  const transactions = settled
    .map(parseOperation)
    .filter((t): t is ScrapedTransaction => t !== null);
  logger.info('[iparitet:stmt] Transactions extracted', { count: transactions.length });
  return transactions;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Map an account number to its `contractNumberHash` (the identifier the history
 * API filters by). Returns undefined if no product matches — the history call
 * then returns operations across all products, which we still persist under the
 * requested account.
 */
async function resolveContractHash(
  page: Page,
  token: string,
  accountNumber: string,
): Promise<string | undefined> {
  const { ok, data } = await apiCallWithRetry(page, { path: PRODUCTS_PATH, method: 'GET', token });
  if (!ok) return undefined;

  const resp = (data ?? {}) as Record<string, ProductRef[] | undefined>;
  const products: ProductRef[] = [
    ...(resp.cardAccount ?? []),
    ...(resp.currentAccount ?? []),
    ...(resp.depositAccount ?? []),
  ];

  const normalise = (s: string) => s.replace(/\s/g, '').toUpperCase();
  const target = normalise(accountNumber);
  const found = products.find(
    (p) =>
      normalise(p.accountNumber ?? '') === target ||
      normalise(p.ibanNum ?? '') === target ||
      normalise(p.contractNumber ?? '') === target,
  );

  if (!found) {
    logger.warn('[iparitet:stmt] Account not matched to a product — fetching all operations', {
      account: accountNumber,
    });
    return undefined;
  }
  return found.contractNumberHash;
}

/**
 * Has the bank actually posted this operation?
 *
 * A card payment first appears as an authorisation hold: it carries an `rrn` but
 * no `operationId`, and the bank's own statement does not list it at all. Once
 * posted, the same operation comes back with a permanent `operationId` (the
 * `rrn` stays). Storing the hold produced a second row for the same payment
 * under a different document number, so pending operations are skipped entirely
 * — they land in the DB when the bank posts them.
 */
function isSettled(op: RawOperation): boolean {
  return String(op.operationId ?? '').trim().length > 0;
}

function parseOperation(op: RawOperation): ScrapedTransaction | null {
  const transactionDate = parseDate(String(op.paymentDate ?? ''));
  if (!transactionDate) return null;

  const amount = Number(op.amount ?? 0) || 0;
  const abs = Math.abs(amount);
  const credit = amount > 0 ? abs : undefined;
  const debit = amount < 0 ? abs : undefined;

  return {
    transactionDate,
    // Only settled operations reach this point, so operationId is always present.
    reference: String(op.operationId).trim(),
    description: op.payName || '—',
    debit,
    credit,
    currency: normaliseCurrency(op.currency),
    counterpartyName: op.payName || undefined,
    operationCode: op.payCode != null ? String(op.payCode) : undefined,
  };
}
