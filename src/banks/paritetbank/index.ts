import { BankAdapter, ScrapedAccount, ScrapedTransaction, StatementRequest } from '../types';
import { resetContext } from '../../scraper/browser';
import { logger } from '../../logger';
import { Page } from 'playwright';
import { login, isLoggedIn } from './auth';
import { scrapeAccounts } from './accounts';
import { scrapeStatement as doScrapeStatement } from './statements';

const API_BASE = '/corporate/web-api/v1';
// eParitet session timeout is not published; ping every 10 min as a precaution.
const KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000;

export class ParitetbankAdapter implements BankAdapter {
  readonly id = 'paritetbank';
  readonly name = 'Паритетбанк BY';

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
    try {
      return await doScrapeStatement(this.activePage!, req);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (/session|sign-in|unauthorized|401/i.test(msg)) {
        logger.warn('[paritetbank] Session expired during statement scrape — re-logging in');
        await this.login();
        return doScrapeStatement(this.activePage!, req);
      }
      throw err;
    }
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
      const ok = await this.activePage.evaluate(async (apiBase: string) => {
        try {
          const res = await fetch(`${apiBase}/info/getSettings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
          });
          return res.ok;
        } catch { return false; }
      }, API_BASE);
      logger.debug('[paritetbank] Session keepalive', { ok });
    } catch (err) {
      logger.debug('[paritetbank] Session keepalive error', { err: String(err) });
    }
  }
}
