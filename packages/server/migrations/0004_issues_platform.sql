ALTER TABLE `issues` ADD `platform` text;--> statement-breakpoint
UPDATE `issues` SET `platform` = (SELECT `events`.`platform` FROM `events` WHERE `events`.`issue_id` = `issues`.`id` ORDER BY `events`.`received_at` DESC LIMIT 1);
