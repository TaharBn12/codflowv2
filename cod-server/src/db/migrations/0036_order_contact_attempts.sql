-- Migration: confirmer contact attempts + per-order activity lookups
--
--   1. `order_contact_attempts` — one row per call / message the confirmation
--      agent logs against an order (outcome, optional note, optional callback
--      time). The (order_id, created_at) index serves both the per-order list
--      and the "calls today" counter behind the 3-calls-per-day rule.
--   2. An (entity_type, entity_id, created_at) index on `activity_logs` so the
--      order activity page reads only that order's audit rows instead of
--      scanning every order log.

CREATE TABLE `order_contact_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL REFERENCES `orders`(`id`) ON DELETE CASCADE,
	`channel` text NOT NULL,
	`outcome` text NOT NULL,
	`note` text,
	`callback_at` text,
	`created_by` text NOT NULL,
	`created_by_name` text NOT NULL,
	`created_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `order_contact_attempts_order_created_idx` ON `order_contact_attempts` (`order_id`, `created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_activity_logs_entity_id_created` ON `activity_logs` (`entity_type`, `entity_id`, `created_at` DESC);
