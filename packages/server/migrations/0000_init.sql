CREATE TABLE `breadcrumbs` (
	`event_id` text NOT NULL,
	`idx` integer NOT NULL,
	`ts` integer NOT NULL,
	`category` text NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`data` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `breadcrumbs_event_idx_pk` ON `breadcrumbs` (`event_id`,`idx`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`release_id` text,
	`fingerprint` text NOT NULL,
	`level` text NOT NULL,
	`platform` text NOT NULL,
	`payload` text NOT NULL,
	`received_at` integer NOT NULL,
	`device_info` text NOT NULL,
	`user_info` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `events_issue_received_idx` ON `events` (`issue_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `events_project_received_idx` ON `events` (`project_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`title` text NOT NULL,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`event_count` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`last_alerted_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issues_proj_fp_uniq` ON `issues` (`project_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `issues_proj_lastseen_idx` ON `issues` (`project_id`,`last_seen`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`public_key` text NOT NULL,
	`webhook_url` text,
	`alert_dedupe_minutes` integer DEFAULT 30 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_uniq` ON `projects` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_public_key_uniq` ON `projects` (`public_key`);--> statement-breakpoint
CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`version` text NOT NULL,
	`build` text NOT NULL,
	`platform` text NOT NULL,
	`mapping_uploaded_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `releases_proj_ver_build_plat_uniq` ON `releases` (`project_id`,`version`,`build`,`platform`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`jti` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `symbolications` (
	`event_id` text NOT NULL,
	`frame_idx` integer NOT NULL,
	`resolved` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `symbolications_event_frame_pk` ON `symbolications` (`event_id`,`frame_idx`);