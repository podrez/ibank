PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sync_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bank` text NOT NULL,
	`status` text NOT NULL,
	`message` text,
	`accounts_found` integer,
	`started_at` text DEFAULT (datetime('now')) NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
INSERT INTO `__new_sync_log`("id", "bank", "status", "message", "accounts_found", "started_at", "finished_at") SELECT "id", "bank", "status", "message", "accounts_found", "started_at", "finished_at" FROM `sync_log`;--> statement-breakpoint
DROP TABLE `sync_log`;--> statement-breakpoint
ALTER TABLE `__new_sync_log` RENAME TO `sync_log`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `transactions` ADD `counterparty_account` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `operation_code` text;