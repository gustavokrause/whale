CREATE TABLE `blockers` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text DEFAULT 'whale' NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`trigger_kind` text NOT NULL,
	`trigger_ref` text NOT NULL,
	`summary` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`action_url` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `blockers_status_idx` ON `blockers` (`status`);