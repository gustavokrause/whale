CREATE TABLE `config` (
	`id` integer PRIMARY KEY NOT NULL,
	`runner` text,
	`model_plan` text,
	`model_route` text,
	`bypass` text,
	`auto_push` integer,
	`allow_new_projects` integer
);
--> statement-breakpoint
CREATE TABLE `inbox_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`project_hint` text,
	`status` text DEFAULT 'raw' NOT NULL,
	`lane` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `inbox_created_idx` ON `inbox_entries` (`created_at`);--> statement-breakpoint
CREATE TABLE `proposed_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'P2' NOT NULL,
	`mode` text DEFAULT 'non-dev' NOT NULL,
	`risk_tier` text,
	`rationale` text DEFAULT '' NOT NULL,
	`bypass` integer DEFAULT false NOT NULL,
	`auto_publish` integer DEFAULT false NOT NULL,
	`deps` text DEFAULT '[]' NOT NULL,
	`refine_log` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`krill_task_id` text,
	`push_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `proposed_status_idx` ON `proposed_tasks` (`status`);