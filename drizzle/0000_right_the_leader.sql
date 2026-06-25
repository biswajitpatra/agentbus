CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sender` text NOT NULL,
	`recipient` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_inbox` ON `messages` (`recipient`,`delivered_at`);--> statement-breakpoint
CREATE TABLE `peers` (
	`name` text PRIMARY KEY NOT NULL,
	`pid` integer NOT NULL,
	`started_at` integer NOT NULL,
	`last_seen` integer NOT NULL
);
