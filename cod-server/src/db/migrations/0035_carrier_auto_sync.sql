-- Migration: carrier status auto-sync
--
-- Two pieces:
--   1. Per-order sync state on `orders` — throttle (last poll time), the raw
--      carrier string seen last (audit for "unmapped" values), and a
--      consecutive-failure counter so a dead tracking number stops being
--      hammered every run.
--   2. Per-company switches on `delivery_companies` + a run log table.
--
-- Polling is the safety net for carriers without inbound webhooks (NOEST,
-- EcoTrack) and the catch-up path for carriers that have them (Yalidine,
-- ZR Express) when a delivery is missed.

ALTER TABLE `orders` ADD `last_tracking_sync_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `last_carrier_status` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `tracking_sync_fails` integer NOT NULL DEFAULT 0;--> statement-breakpoint

ALTER TABLE `delivery_companies` ADD `auto_sync_enabled` integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE `delivery_companies` ADD `auto_sync_interval_min` integer NOT NULL DEFAULT 30;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `carrier_sync_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `delivery_companies`(`id`) ON DELETE CASCADE,
  `trigger` text NOT NULL DEFAULT 'cron',
  -- 'poll' = one tracking call per order; 'reconcile' = EcoTrack list endpoint
  `mode` text NOT NULL DEFAULT 'poll',
  `started_at` text NOT NULL,
  `finished_at` text,
  `scanned` integer NOT NULL DEFAULT 0,
  `polled` integer NOT NULL DEFAULT 0,
  `updated` integer NOT NULL DEFAULT 0,
  `unchanged` integer NOT NULL DEFAULT 0,
  `unmapped` integer NOT NULL DEFAULT 0,
  `errors` integer NOT NULL DEFAULT 0,
  `unmapped_statuses` text,
  `error_message` text
);--> statement-breakpoint

-- Dashboard "sync history" list (newest first, per company).
CREATE INDEX IF NOT EXISTS `idx_carrier_sync_runs_company` ON `carrier_sync_runs` (`company_id`, `started_at` DESC);--> statement-breakpoint

-- Auto-sync candidate scan: only rows with a tracking number, oldest sync first.
CREATE INDEX IF NOT EXISTS `idx_orders_tracking_sync_due` ON `orders` (`last_tracking_sync_at`) WHERE `tracking_number` IS NOT NULL;
