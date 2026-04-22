-- Add bank discriminator to accounts table
ALTER TABLE `accounts` ADD COLUMN `bank` text NOT NULL DEFAULT 'alfabank';
--> statement-breakpoint
-- Replace single-column unique index with composite (bank, account_number)
DROP INDEX IF EXISTS `accounts_account_number_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_bank_account_unique` ON `accounts` (`bank`, `account_number`);
--> statement-breakpoint
-- Add bank discriminator to sync_log table
ALTER TABLE `sync_log` ADD COLUMN `bank` text NOT NULL DEFAULT 'alfabank';
