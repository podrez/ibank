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
  /** Name of the counterparty (organisation or person) */
  counterpartyName?: string;
  /** Bank account number (IBAN) of the counterparty */
  counterpartyAccount?: string;
  /** Bank operation/transaction type code */
  operationCode?: string;
}

export interface StatementRequest {
  accountNumber: string;
  /** Inclusive start date (ISO yyyy-MM-dd) */
  dateFrom: string;
  /** Inclusive end date (ISO yyyy-MM-dd) */
  dateTo: string;
}

/** An outgoing payment order as the bank's document list shows it. */
export interface PaymentOrder {
  /** Document number as entered (string — banks allow non-numeric numbers) */
  number: string;
  /** ISO date yyyy-MM-dd the document was created / dated */
  date: string;
  /** Bank's status text, e.g. "Проведен банком" */
  status: string;
  amount: number;
  currency: string;
  payerAccount: string;
  recipientName?: string;
  recipientAccount?: string;
  purpose?: string;
}

export interface LastPaymentOrderResult {
  /** Highest number used this year (see the adapter) — null if no documents found */
  lastNumber: string | null;
  /** The document carrying {@link lastNumber} */
  document: PaymentOrder | null;
  /** How many documents were examined */
  examined: number;
}

export interface BankAdapter {
  /** Unique identifier, used as the "bank" discriminator in the DB */
  readonly id: string;
  /** Human-readable name for logs */
  readonly name: string;
  /**
   * When true, this bank is synced around the clock (every interval, all days)
   * instead of only during the business-hours window. Retail/physical-person
   * banks (e.g. iParitet) operate 24/7, unlike corporate banking systems.
   */
  readonly roundTheClock?: boolean;

  isLoggedIn(): Promise<boolean>;
  login(): Promise<void>;
  scrapeAccounts(): Promise<ScrapedAccount[]>;
  resetSession(): Promise<void>;

  /**
   * Optional: download transactions for a given account and date range.
   * If not implemented, statement sync is skipped for this bank.
   */
  scrapeStatement?(req: StatementRequest): Promise<ScrapedTransaction[]>;

  /**
   * Optional: number of the last outgoing payment order, read live from the bank.
   * `account` narrows it to one payer account.
   */
  getLastPaymentOrder?(opts?: { account?: string }): Promise<LastPaymentOrderResult>;
}
