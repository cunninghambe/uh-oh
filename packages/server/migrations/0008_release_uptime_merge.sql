CREATE TABLE `fingerprint_aliases` (
	`project_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`issue_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fingerprint_aliases_project_fp_uniq` ON `fingerprint_aliases` (`project_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `fingerprint_aliases_issue_idx` ON `fingerprint_aliases` (`issue_id`);--> statement-breakpoint
ALTER TABLE `monitors` ADD `kind` text DEFAULT 'checkin' NOT NULL;--> statement-breakpoint
ALTER TABLE `monitors` ADD `url` text;--> statement-breakpoint
ALTER TABLE `monitors` ADD `timeout_ms` integer;--> statement-breakpoint
ALTER TABLE `monitors` ADD `last_probe_at` integer;--> statement-breakpoint
ALTER TABLE `monitors` ADD `last_probe_status` integer;--> statement-breakpoint
ALTER TABLE `monitors` ADD `consecutive_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `release` text;