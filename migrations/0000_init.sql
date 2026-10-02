CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`actor_id` text,
	`at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_entity` ON `audit_log` (`org_id`,`entity`,`entity_id`,`at`);--> statement-breakpoint
CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`contact_person` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`gstin` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_org_code` ON `clients` (`org_id`,`code`);--> statement-breakpoint
CREATE TABLE `counters` (
	`org_id` text NOT NULL,
	`key` text NOT NULL,
	`value` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`org_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `dispatch_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`dispatch_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`location_id` text NOT NULL,
	`lot_id` text NOT NULL,
	`item_id` text NOT NULL,
	`grams` integer NOT NULL,
	`bags` integer NOT NULL,
	`packages` integer NOT NULL,
	`superseded_at` text,
	FOREIGN KEY (`dispatch_id`) REFERENCES `dispatches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lot_id`) REFERENCES `lots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dispatch_lines_dispatch` ON `dispatch_lines` (`dispatch_id`);--> statement-breakpoint
CREATE INDEX `dispatch_lines_balance` ON `dispatch_lines` (`location_id`,`lot_id`);--> statement-breakpoint
CREATE TABLE `dispatch_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`dispatch_id` text NOT NULL,
	`line_id` text NOT NULL,
	`lot_id` text NOT NULL,
	`seq` integer NOT NULL,
	`barcode` text NOT NULL,
	`grams` integer NOT NULL,
	`bags` integer NOT NULL,
	`status` text DEFAULT 'PREPARED' NOT NULL,
	`print_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`dispatched_at` text,
	`cancelled_at` text,
	FOREIGN KEY (`dispatch_id`) REFERENCES `dispatches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`line_id`) REFERENCES `dispatch_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lot_id`) REFERENCES `lots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dispatch_packages_barcode` ON `dispatch_packages` (`barcode`);--> statement-breakpoint
CREATE INDEX `dispatch_packages_dispatch` ON `dispatch_packages` (`dispatch_id`);--> statement-breakpoint
CREATE TABLE `dispatches` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`no` text NOT NULL,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`client_id` text NOT NULL,
	`dispatch_date` text NOT NULL,
	`destination` text DEFAULT '' NOT NULL,
	`vehicle_no` text DEFAULT '' NOT NULL,
	`transporter` text DEFAULT '' NOT NULL,
	`driver_name` text DEFAULT '' NOT NULL,
	`driver_phone` text DEFAULT '' NOT NULL,
	`reference` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`txn_id` text,
	`status_reason` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text,
	`updated_at` text NOT NULL,
	`posted_at` text,
	`posted_by` text,
	`closed_at` text,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`posted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dispatches_org_no` ON `dispatches` (`org_id`,`no`);--> statement-breakpoint
CREATE INDEX `dispatches_org_status` ON `dispatches` (`org_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`coffee_type` text DEFAULT '' NOT NULL,
	`form` text DEFAULT '' NOT NULL,
	`grade` text DEFAULT '' NOT NULL,
	`bag_grams` integer,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_org_code` ON `items` (`org_id`,`code`);--> statement-breakpoint
CREATE TABLE `locations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`parent_id` text,
	`kind` text DEFAULT 'GODOWN' NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `locations_org_code` ON `locations` (`org_id`,`code`);--> statement-breakpoint
CREATE TABLE `lots` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`code` text NOT NULL,
	`item_id` text NOT NULL,
	`source_type` text DEFAULT 'RECEIPT' NOT NULL,
	`source_id` text,
	`source_ref` text DEFAULT '' NOT NULL,
	`crop_year` text DEFAULT '' NOT NULL,
	`moisture_pct` real,
	`outturn_pct` real,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lots_org_code` ON `lots` (`org_id`,`code`);--> statement-breakpoint
CREATE INDEX `lots_item` ON `lots` (`item_id`);--> statement-breakpoint
CREATE TABLE `orgs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`timezone` text DEFAULT 'Asia/Kolkata' NOT NULL,
	`label_width_mm` integer DEFAULT 100 NOT NULL,
	`label_height_mm` integer DEFAULT 75 NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stock_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text NOT NULL,
	`txn_id` text NOT NULL,
	`location_id` text NOT NULL,
	`lot_id` text NOT NULL,
	`item_id` text NOT NULL,
	`grams` integer NOT NULL,
	`bags` integer NOT NULL,
	`effective_date` text NOT NULL,
	FOREIGN KEY (`txn_id`) REFERENCES `stock_txns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lot_id`) REFERENCES `lots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stock_ledger_balance` ON `stock_ledger` (`location_id`,`lot_id`);--> statement-breakpoint
CREATE INDEX `stock_ledger_lot` ON `stock_ledger` (`lot_id`);--> statement-breakpoint
CREATE INDEX `stock_ledger_txn` ON `stock_ledger` (`txn_id`);--> statement-breakpoint
CREATE INDEX `stock_ledger_org` ON `stock_ledger` (`org_id`);--> statement-breakpoint
CREATE TABLE `stock_txns` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`no` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'POSTED' NOT NULL,
	`effective_date` text NOT NULL,
	`posted_at` text NOT NULL,
	`posted_by` text,
	`reference` text DEFAULT '' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`reverses_id` text,
	`dispatch_id` text,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`posted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_txns_org_no` ON `stock_txns` (`org_id`,`no`);--> statement-breakpoint
CREATE UNIQUE INDEX `stock_txns_reverses` ON `stock_txns` (`reverses_id`);--> statement-breakpoint
CREATE INDEX `stock_txns_org_posted` ON `stock_txns` (`org_id`,`posted_at`);--> statement-breakpoint
CREATE TABLE `user_godowns` (
	`user_id` text NOT NULL,
	`location_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `location_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`login` text NOT NULL,
	`full_name` text NOT NULL,
	`role` text NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`disabled_at` text,
	`last_seen_at` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_login` ON `users` (`login`);