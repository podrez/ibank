import { Page } from 'playwright';
import { BankAdapter, ScrapedAccount, ScrapedTransaction, StatementRequest } from '../types';
import { resetContext } from '../../scraper/browser';
import { logger } from '../../logger';
import { login, isLoggedIn } from './auth';
import { scrapeAccounts } from './accounts';
import { scrapeStatement as doScrapeStatement } from './statements';

const KEEPALIVE_URL = '/Bia.Controllers/SessionIsAlive/Check';
// BIA platform default session timeout is ~20 min; ping every 10 min to stay safe.
const KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000;

export class BelvebAdapter implements BankAdapter {
  readonly id = 'belveb';
  readonly name = 'БелВЭБ BY';

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
    // Always reset the browser context before logging in.
    // After a navigation timeout the existing context may be stuck, and creating
    // a new page inside it would inherit the broken state.
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
      const ok = await this.activePage.evaluate(async (url: string) => {
        try {
          const res = await fetch(url, { credentials: 'same-origin' });
          return res.ok;
        } catch { return false; }
      }, KEEPALIVE_URL);
      logger.debug('[belveb] Session keepalive', { ok });
    } catch (err) {
      logger.debug('[belveb] Session keepalive error', { err: String(err) });
    }
  }
}
