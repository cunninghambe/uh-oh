CREATE TABLE `monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text,
	`interval_minutes` integer NOT NULL,
	`grace_minutes` integer NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`last_check_in_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monitors_project_slug_uniq` ON `monitors` (`project_id`,`slug`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_webhook_dispatches` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text,
	`event_id` text,
	`monitor_id` text,
	`url` text NOT NULL,
	`type` text DEFAULT 'issue.new' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_error` text,
	`last_response_code` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_webhook_dispatches`("id", "issue_id", "event_id", "url", "type", "attempt", "next_attempt_at", "status", "last_error", "last_response_code", "created_at") SELECT "id", "issue_id", "event_id", "url", "type", "attempt", "next_attempt_at", "status", "last_error", "last_response_code", "created_at" FROM `webhook_dispatches`;--> statement-breakpoint
DROP TABLE `webhook_dispatches`;--> statement-breakpoint
ALTER TABLE `__new_webhook_dispatches` RENAME TO `webhook_dispatches`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `webhook_dispatches_status_due_idx` ON `webhook_dispatches` (`status`,`next_attempt_at`);