import { sqliteTable, text, real, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';


export const accounts = sqliteTable(
  'accounts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    bank: text('bank').notNull(),
    accountNumber: text('account_number').notNull(),
    currency: text('currency').notNull(),
    name: text('name'),
    balance: real('balance'),
    available: real('available'),
    balanceUpdatedAt: text('balance_updated_at'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({
    bankAccountUnique: uniqueIndex('accounts_bank_account_unique').on(t.bank, t.accountNumber),
  }),
);

export const syncLog = sqliteTable('sync_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  bank: text('bank').notNull(),
  status: text('status').notNull(),
  message: text('message'),
  accountsFound: integer('accounts_found'),
  startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
  finishedAt: text('finished_at'),
});

/**
 * Bank statement transactions.
 * Deduplication key: (bank, account_number, transaction_date, tx_key)
 * where tx_key = reference document number, or hash(description|debit|credit) when absent.
 */
export const transactions = sqliteTable(
  'transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    bank: text('bank').notNull(),
    accountNumber: text('account_number').notNull(),
    /** ISO date yyyy-MM-dd */
    transactionDate: text('transaction_date').notNull(),
    /** Bank-assigned document/reference number */
    reference: text('reference'),
    /** Payment description / purpose */
    description: text('description'),
    /** Debit amount (expense, outgoing) */
    debit: real('debit'),
    /** Credit amount (income, incoming) */
    credit: real('credit'),
    currency: text('currency').notNull(),
    /** УНП (taxpayer ID) of the counterparty */
    counterpartyUnp: text('counterparty_unp'),
    /** Name of the counterparty (organisation or person) */
    counterpartyName: text('counterparty_name'),
    /**
     * Deterministic dedup key: reference when available,
     * otherwise a stable string derived from date+description+amounts.
     */
    txKey: text('tx_key').notNull(),
    importedAt: text('imported_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({
    txUnique: uniqueIndex('transactions_uniq').on(t.bank, t.accountNumber, t.transactionDate, t.txKey),
  }),
);
