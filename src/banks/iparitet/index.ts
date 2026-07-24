import { BankAdapter, ScrapedAccount, ScrapedTransaction, StatementRequest } from '../types';
import { resetContext } from '../../scraper/browser';
import { logger } from '../../logger';
import { Page } from 'playwright';
import { login, isLoggedIn } from './auth';
import { scrapeAccounts } from './accounts';
import { scrapeStatement as doScrapeStatement } from './statements';
import { CORE_API, apiCall, waitForSessionToken } from './api';

const PRODUCTS_PATH = `${CORE_API}/product/get-products?getCreditDetail=false`;
// iParitet session timeout is not published; ping every 5 min to keep it warm.
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Паритетбанк for physical persons (https://iparitet.by).
 *
 * Distinct from the corporate {@link ParitetbankAdapter} (eparitet.by): a
 * different Angular SPA with a bearer-token JSON API. Login requires an SMS
 * one-time code, so the scheduler is session-only (see ./auth.ts) and an
 * operator restores access via the interactive SMS flow in the settings UI.
 */
export class IparitetAdapter implements BankAdapter {
  readonly id = 'iparitet';
  readonly name = 'Паритетбанк (физлица)';
  // Retail bank — operates 24/7, so sync it outside the business-hours window too.
  readonly roundTheClock = true;

  private activePage: Page | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  async isLoggedIn(): Promise<boolean> {
    if (!this.activePage || this.activePage.isClosed()) return false;
    return isLoggedIn(this.activePage);
  }

  async login(): Promise<void> {
    this.stopKeepAlive();
    if (this.activePage && !this.activePage.isClosed()) {
      await this.activePage.close().catch(() => null);
    }
    this.activePage = null;
    await resetContext(this.id);
    this.activePage = await login();
    this.startKeepAlive();
  }

  async scrapeAccounts(): Promise<ScrapedAccount[]> {
    return scrapeAccounts(this.activePage!);
  }

  async scrapeStatement(req: StatementRequest): Promise<ScrapedTransaction[]> {
    return doScrapeStatement(this.activePage!, req);
  }

  async resetSession(): Promise<void> {
    this.stopKeepAlive();
    this.activePage = null;
    await resetContext(this.id);
  }

  private startKeepAlive(): void {
    this.keepAliveTimer = setInterval(() => { void this.pingSession(); }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private async pingSession(): Promise<void> {
    if (!this.activePage || this.activePage.isClosed()) {
      this.stopKeepAlive();
      return;
    }
    try {
      const token = await waitForSessionToken(this.activePage, 2_000);
      if (!token) { logger.debug('[iparitet] Session keepalive — no token'); return; }
      const { ok } = await apiCall(this.activePage, { path: PRODUCTS_PATH, method: 'GET', token });
      logger.debug('[iparitet] Session keepalive', { ok });
    } catch (err) {
      logger.debug('[iparitet] Session keepalive error', { err: String(err) });
    }
  }
}
