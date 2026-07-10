ALTER TABLE `proposed_tasks` ADD `expected_impact` text;--> statement-breakpoint
ALTER TABLE `proposed_tasks` ADD `skip_plan` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `proposed_tasks` ADD `skip_ai_review` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `proposed_tasks` ADD `skip_verify` integer;