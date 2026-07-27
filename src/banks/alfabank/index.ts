import { Page } from 'playwright';
import { BankAdapter, ScrapedAccount, ScrapedTransaction, StatementRequest } from '../types';
import { clearSession } from '../../scraper/browser';
import { login, isLoggedIn, resetAutoLoginBlock } from './auth';
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
    // Credentials changed / explicit logout → drop the persisted session too, and
    // re-enable automatic login so the new details are tried on the next sync.
    resetAutoLoginBlock();
    await clearSession(this.id);
  }
}
