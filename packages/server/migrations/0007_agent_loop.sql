CREATE TABLE `fix_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`pr_url` text NOT NULL,
	`commit_sha` text,
	`state` text DEFAULT 'filed' NOT NULL,
	`created_at` integer NOT NULL,
	`deployed_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fix_attempts_issue_pr_uniq` ON `fix_attempts` (`issue_id`,`pr_url`);--> statement-breakpoint
CREATE INDEX `fix_attempts_issue_created_idx` ON `fix_attempts` (`issue_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `fix_attempts_state_deployed_idx` ON `fix_attempts` (`state`,`deployed_at`);--> statement-breakpoint
CREATE TABLE `issue_annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`author` text DEFAULT 'agent' NOT NULL,
	`kind` text DEFAULT 'note' NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_annotations_issue_created_idx` ON `issue_annotations` (`issue_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `issues` ADD `spike_active` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `issues` ADD `last_spike_at` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `repo_url` text;--> statement-breakpoint
ALTER TABLE `releases` ADD `commit_sha` text;