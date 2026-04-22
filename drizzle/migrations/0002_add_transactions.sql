-- Create transactions table for bank statement storage
CREATE TABLE `transactions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `bank` text NOT NULL,
  `account_number` text NOT NULL,
  `transaction_date` text NOT NULL,
  `value_date` text,
  `reference` text,
  `description` text,
  `debit` real,
  `credit` real,
  `currency` text NOT NULL,
  `balance` real,
  `tx_key` text NOT NULL,
  `imported_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_uniq` ON `transactions` (`bank`, `account_number`, `transaction_date`, `tx_key`);
