CREATE TABLE `webhook_dispatches` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`event_id` text NOT NULL,
	`url` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_error` text,
	`last_response_code` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_dispatches_status_due_idx` ON `webhook_dispatches` (`status`,`next_attempt_at`);