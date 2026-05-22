import { Page } from 'playwright';
import { BankAdapter, ScrapedAccount, ScrapedTransaction, StatementRequest } from '../types';
import { resetContext } from '../../scraper/browser';
import { login, isLoggedIn } from './auth';
import { scrapeAccounts } from './accounts';
import { scrapeStatement as doScrapeStatement } from './statements';

export class BelvebAdapter implements BankAdapter {
  readonly id = 'belveb';
  readonly name = 'БелВЭБ BY';

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
    // Always reset the browser context before logging in.
    // After a navigation timeout the existing context may be stuck, and creating
    // a new page inside it would inherit the broken state.
    await resetContext(this.id);
    this.activePage = await login();
  }

  async scrapeAccounts(): Promise<ScrapedAccount[]> {
    return scrapeAccounts(this.activePage!);
  }

  async scrapeStatement(req: StatementRequest): Promise<ScrapedTransaction[]> {
    return doScrapeStatement(this.activePage!, req);
  }

  async resetSession(): Promise<void> {
    this.activePage = null;
    await resetContext(this.id);
  }
}
