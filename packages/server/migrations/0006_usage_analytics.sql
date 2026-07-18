CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text,
	`path` text,
	`referrer_domain` text,
	`visitor` text NOT NULL,
	`props` text,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `usage_events_project_received_idx` ON `usage_events` (`project_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `usage_salts` (
	`date` text PRIMARY KEY NOT NULL,
	`salt` text NOT NULL
);
