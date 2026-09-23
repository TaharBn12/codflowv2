-- Migration: order risk control + reusable views
--
-- Three pieces the /orders page needs and the schema could not give it:
--
--   1. `idx_orders_phone_created` — duplicate detection groups orders by phone
--      inside a rolling window, and the blacklist badge on a list row is a
--      correlated lookup on the same column. Both scanned every order in the
--      table before this index existed.
--
--   2. `customer_blacklist` — banned phones and IPs. Membership is *derived*
--      at read time (the orders list/detail look the phone up) instead of
--      being copied onto the order row, so lifting a ban stops flagging that
--      customer's history immediately and no order column is needed.
--      `value` is always the canonical match key: local Algerian mobile
--      ("0551234567") for phones — the same form orders.phone is validated
--      into on both the storefront and dashboard paths — and the trimmed
--      literal for IPs.
--
--   3. `saved_views` — named filters AND carrier export templates. Stored
--      server-side (not localStorage) so a view can be shared with the team
--      and survives a browser/device change. `kind` tells the two shapes
--      apart: an orders-filter row uses filters/sort, an export-template row
--      uses columns/headers/carrier_id.

CREATE INDEX IF NOT EXISTS `idx_orders_phone_created` ON `orders` (`phone`, `created_at` DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `customer_blacklist` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('phone', 'ip')),
  `value` text NOT NULL,
  `raw_value` text NOT NULL,
  `reason` text,
  `status` text NOT NULL DEFAULT 'active' CHECK (`status` IN ('active', 'lifted')),
  -- Orders placed while the entry was active (audit — how much this ban saved).
  `hit_count` integer NOT NULL DEFAULT 0,
  `last_hit_at` text,
  `created_by` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `created_at` text NOT NULL,
  `lifted_at` text,
  `lifted_by` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `lifted_reason` text
);--> statement-breakpoint

-- One live ban per (kind, value). Lifted rows stay for the audit trail, and a
-- re-ban inserts a fresh row rather than resurrecting the old one.
CREATE UNIQUE INDEX IF NOT EXISTS `customer_blacklist_active_unique`
  ON `customer_blacklist` (`kind`, `value`) WHERE `status` = 'active';--> statement-breakpoint

-- Management list: newest first, filtered by status.
CREATE INDEX IF NOT EXISTS `customer_blacklist_status_created_idx`
  ON `customer_blacklist` (`status`, `created_at` DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `saved_views` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL DEFAULT 'orders-filter' CHECK (`kind` IN ('orders-filter', 'export-template')),
  `name` text NOT NULL,
  `owner_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  -- 0 = private to the owner, 1 = visible to everyone who can read orders.
  `shared` integer NOT NULL DEFAULT 0,
  -- JSON: the orders-list filter state (see OrderFilters in the dashboard).
  `filters` text NOT NULL DEFAULT '{}',
  `sort_key` text,
  `sort_direction` text CHECK (`sort_direction` IN ('asc', 'desc')),
  -- JSON array of export column keys, in the order the carrier file needs.
  `columns` text,
  -- JSON map of column key -> header text override (the carrier's own wording).
  `headers` text,
  `carrier_id` text REFERENCES `delivery_companies`(`id`) ON DELETE CASCADE,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `saved_views_owner_idx`
  ON `saved_views` (`kind`, `owner_id`, `updated_at` DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `saved_views_shared_idx`
  ON `saved_views` (`kind`, `shared`, `updated_at` DESC);
