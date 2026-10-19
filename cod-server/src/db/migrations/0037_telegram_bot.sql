-- Migration: interactive Telegram bot
--
-- Turns the one-way approval messenger into a full command center:
--   1. `telegram_user_links`   — one CodFlow user ↔ one Telegram account,
--      with per-user notification preferences and language.
--   2. `telegram_link_codes`   — short-lived one-time codes the dashboard
--      generates so a team member can bind their own Telegram account.
--   3. `telegram_bot_sessions` — conversation state (awaiting search, awaiting
--      rejection reason…) so multi-step flows survive across updates.
--   4. `telegram_update_log`   — Telegram `update_id` dedupe (a retried update
--      must never apply a status change twice).
--   5. `telegram_bot_events`   — audit trail for every bot action.
--   6. `telegram_digest_queue` — alerts queued while digest mode / quiet hours
--      are active, flushed by the hourly cron.
--   7. `telegram_bot_config`   — single-row bot behaviour settings.
--   8. `telegram_alert_state`  — per-alert-key dedupe so a stuck shipment is
--      announced once a day, not every hour.
--   9. Approval reminder / escalation columns on `admin_approval_requests`.

CREATE TABLE IF NOT EXISTS `telegram_user_links` (
  `telegram_user_id` text PRIMARY KEY NOT NULL,
  `chat_id` text NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `username` text,
  `first_name` text,
  `language` text NOT NULL DEFAULT 'ar' CHECK (`language` IN ('ar', 'fr', 'en')),
  `notify_orders` integer NOT NULL DEFAULT 1,
  `notify_shipping` integer NOT NULL DEFAULT 1,
  `notify_stock` integer NOT NULL DEFAULT 1,
  `notify_finance` integer NOT NULL DEFAULT 1,
  `notify_support` integer NOT NULL DEFAULT 0,
  `notify_approvals` integer NOT NULL DEFAULT 1,
  `notify_reports` integer NOT NULL DEFAULT 1,
  `digest_mode` text NOT NULL DEFAULT 'instant' CHECK (`digest_mode` IN ('instant', 'hourly', 'daily')),
  `muted_until` text,
  `linked_at` text NOT NULL,
  `last_seen_at` text,
  `revoked_at` text
);
CREATE UNIQUE INDEX IF NOT EXISTS `telegram_user_links_user_idx` ON `telegram_user_links` (`user_id`);
CREATE INDEX IF NOT EXISTS `telegram_user_links_chat_idx` ON `telegram_user_links` (`chat_id`);

CREATE TABLE IF NOT EXISTS `telegram_link_codes` (
  `code` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `created_by` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `expires_at` text NOT NULL,
  `used_at` text,
  `used_by_telegram_id` text,
  `created_at` text NOT NULL
);
CREATE INDEX IF NOT EXISTS `telegram_link_codes_user_idx` ON `telegram_link_codes` (`user_id`, `expires_at`);

CREATE TABLE IF NOT EXISTS `telegram_bot_sessions` (
  `telegram_user_id` text PRIMARY KEY NOT NULL,
  `state` text NOT NULL DEFAULT 'idle',
  `payload` text,
  `updated_at` text NOT NULL
);

CREATE TABLE IF NOT EXISTS `telegram_update_log` (
  `update_id` text PRIMARY KEY NOT NULL,
  `telegram_user_id` text,
  `kind` text,
  `received_at` text NOT NULL
);

CREATE TABLE IF NOT EXISTS `telegram_bot_events` (
  `id` text PRIMARY KEY NOT NULL,
  `telegram_user_id` text,
  `user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `action` text NOT NULL,
  `target_type` text,
  `target_id` text,
  `status` text NOT NULL DEFAULT 'ok' CHECK (`status` IN ('ok', 'denied', 'failed')),
  `detail` text,
  `created_at` text NOT NULL
);
CREATE INDEX IF NOT EXISTS `telegram_bot_events_created_idx` ON `telegram_bot_events` (`created_at`);
CREATE INDEX IF NOT EXISTS `telegram_bot_events_user_idx` ON `telegram_bot_events` (`user_id`, `created_at`);

CREATE TABLE IF NOT EXISTS `telegram_digest_queue` (
  `id` text PRIMARY KEY NOT NULL,
  `telegram_user_id` text NOT NULL,
  `kind` text NOT NULL,
  `text` text NOT NULL,
  `created_at` text NOT NULL,
  `sent_at` text
);
CREATE INDEX IF NOT EXISTS `telegram_digest_queue_pending_idx` ON `telegram_digest_queue` (`telegram_user_id`, `sent_at`, `created_at`);

CREATE TABLE IF NOT EXISTS `telegram_bot_config` (
  `id` text PRIMARY KEY NOT NULL DEFAULT 'default',
  `enabled` integer NOT NULL DEFAULT 1,
  `default_language` text NOT NULL DEFAULT 'ar' CHECK (`default_language` IN ('ar', 'fr', 'en')),
  `quiet_hours_start` integer NOT NULL DEFAULT 23,
  `quiet_hours_end` integer NOT NULL DEFAULT 7,
  `digest_interval_minutes` integer NOT NULL DEFAULT 60,
  `weekly_report_enabled` integer NOT NULL DEFAULT 1,
  `weekly_report_day` integer NOT NULL DEFAULT 6,
  `weekly_report_hour` integer NOT NULL DEFAULT 20,
  `monthly_report_enabled` integer NOT NULL DEFAULT 1,
  `monthly_report_hour` integer NOT NULL DEFAULT 20,
  `last_weekly_sent_on` text,
  `last_monthly_sent_on` text,
  `updated_at` text NOT NULL
);

CREATE TABLE IF NOT EXISTS `telegram_alert_state` (
  `key` text PRIMARY KEY NOT NULL,
  `severity` text NOT NULL DEFAULT 'warning',
  `last_sent_at` text NOT NULL,
  `detail` text
);

ALTER TABLE `admin_approval_requests` ADD COLUMN `reminder_sent_at` text;
ALTER TABLE `admin_approval_requests` ADD COLUMN `escalated_at` text;
