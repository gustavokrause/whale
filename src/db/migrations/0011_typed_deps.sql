ALTER TABLE `proposed_tasks` ADD `dep_types` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `proposed_tasks` ADD `premise` text;--> statement-breakpoint
ALTER TABLE `proposed_tasks` ADD `reeval_status` text;--> statement-breakpoint
ALTER TABLE `proposed_tasks` ADD `reeval_note` text;--> statement-breakpoint
ALTER TABLE `proposed_tasks` ADD `reeval_source` text;