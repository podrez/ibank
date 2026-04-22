CREATE TABLE `accounts` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_number` text NOT NULL,
  `currency` text NOT NULL,
  `name` text,
  `balance` real,
  `available` real,
  `balance_updated_at` text,
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_account_number_unique` ON `accounts` (`account_number`);
--> statement-breakpoint
CREATE TABLE `sync_log` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `status` text NOT NULL,
  `message` text,
  `accounts_found` integer,
  `started_at` text NOT NULL DEFAULT (datetime('now')),
  `finished_at` text
);
