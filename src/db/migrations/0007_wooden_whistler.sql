ALTER TABLE `config` ADD `consensus` integer;--> statement-breakpoint
ALTER TABLE `proposed_tasks` ADD `owner_persona` text;--> statement-breakpoint
ALTER TABLE `proposed_tasks` ADD `owner_area` text;--> statement-breakpoint
ALTER TABLE `proposed_tasks` ADD `consensus_log` text DEFAULT '[]' NOT NULL;