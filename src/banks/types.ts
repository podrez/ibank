export interface ScrapedAccount {
  accountNumber: string;
  currency: string;
  name: string;
  balance: number;
  available: number | null;
}

export interface ScrapedTransaction {
  /** ISO date yyyy-MM-dd */
  transactionDate: string;
  /** Bank-assigned document/reference number */
  reference?: string;
  /** Payment description / purpose */
  description: string;
  /** Debit amount (expense, outgoing) — mutually exclusive with credit */
  debit?: number;
  /** Credit amount (income, incoming) — mutually exclusive with debit */
  credit?: number;
  currency: string;
  /** УНП (taxpayer ID) of the counterparty */
  counterpartyUnp?: string;
}

export interface StatementRequest {
  accountNumber: string;
  /** Inclusive start date (ISO yyyy-MM-dd) */
  dateFrom: string;
  /** Inclusive end date (ISO yyyy-MM-dd) */
  dateTo: string;
}

export interface BankAdapter {
  /** Unique identifier, used as the "bank" discriminator in the DB */
  readonly id: string;
  /** Human-readable name for logs */
  readonly name: string;

  isLoggedIn(): Promise<boolean>;
  login(): Promise<void>;
  scrapeAccounts(): Promise<ScrapedAccount[]>;
  resetSession(): Promise<void>;

  /**
   * Optional: download transactions for a given account and date range.
   * If not implemented, statement sync is skipped for this bank.
   */
  scrapeStatement?(req: StatementRequest): Promise<ScrapedTransaction[]>;
}
