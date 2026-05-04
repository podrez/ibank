import { Page } from 'playwright';
import { BankAdapter, ScrapedAccount, ScrapedTransaction, StatementRequest } from '../types';
import { resetContext } from '../../scraper/browser';
import { login, isLoggedIn } from './auth';
import { scrapeAccounts } from './accounts';
import { scrapeStatement as doScrapeStatement } from './statements';

export class AlfabankAdapter implements BankAdapter {
  readonly id = 'alfabank';
  readonly name = 'Alfa-Bank BY';

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

  async resetSession(): Promise<void> {
    this.activePage = null;
    await resetContext(this.id);
  }
}
