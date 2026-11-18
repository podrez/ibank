import { Page } from 'playwright';
import { BankAdapter, LastPaymentOrderResult, ScrapedAccount, ScrapedTransaction, StatementRequest } from '../types';
import { getLastPaymentOrder as doGetLastPaymentOrder } from './payments';
import { resetContext } from '../../scraper/browser';
import { login, isLoggedIn } from './auth';
import { scrapeAccounts } from './accounts';
import { scrapeStatement as doScrapeStatement } from './statements';

export class PriorbankAdapter implements BankAdapter {
  readonly id = 'priorbank';
  readonly name = 'Priorbank BY';

  private activePage: Page | null = null;

  async isLoggedIn(): Promise<boolean> {
    if (!this.activePage || this.activePage.isClosed()) return false;
    return isLoggedIn(this.activePage);
  }

  async login(): Promise<void> {
    if (this.activePage && !this.activePage.isClosed()) {
      await this.activePage.close().catch(() => null);
    }
    this.activePage = null;
    this.activePage = await login();
  }

  async scrapeAccounts(): Promise<ScrapedAccount[]> {
    return scrapeAccounts(this.activePage!);
  }

  async scrapeStatement(req: StatementRequest): Promise<ScrapedTransaction[]> {
    return doScrapeStatement(this.activePage!, req);
  }

  async getLastPaymentOrder(opts?: { account?: string }): Promise<LastPaymentOrderResult> {
    if (!(await this.isLoggedIn())) await this.loginShared();
    try {
      return await doGetLastPaymentOrder(this.activePage!, opts);
    } catch (err) {
      if (!/session expired/i.test((err as Error).message)) throw err;
      await this.loginShared();
      return doGetLastPaymentOrder(this.activePage!, opts);
    }
  }

  /** Concurrent API requests share one login instead of each opening a page. */
  private loginInFlight: Promise<void> | null = null;
  private loginShared(): Promise<void> {
    this.loginInFlight ??= this.login().finally(() => { this.loginInFlight = null; });
    return this.loginInFlight;
  }

  async resetSession(): Promise<void> {
    this.activePage = null;
    await resetContext(this.id);
  }
}
