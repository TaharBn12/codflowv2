-- Dashboard analytics: business expenses (ad spend / carrier / other costs) for
-- ROAS + P&L, per-user dashboard widget layouts, and the automated daily
-- report configuration.

CREATE TABLE IF NOT EXISTS business_expenses (
  id TEXT PRIMARY KEY NOT NULL,
  date TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('ads', 'carrier', 'packaging', 'salaries', 'rent', 'other')),
  platform TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'DZD',
  landing_page_id TEXT REFERENCES landing_pages(id) ON DELETE SET NULL,
  note TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS business_expenses_date_idx ON business_expenses(date, category);
CREATE INDEX IF NOT EXISTS business_expenses_landing_page_idx ON business_expenses(landing_page_id);

CREATE TABLE IF NOT EXISTS dashboard_layouts (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  layout TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dashboard_report_config (
  id TEXT PRIMARY KEY NOT NULL DEFAULT 'default',
  enabled INTEGER NOT NULL DEFAULT 0,
  send_hour INTEGER NOT NULL DEFAULT 20,
  timezone TEXT NOT NULL DEFAULT 'Africa/Algiers',
  telegram_enabled INTEGER NOT NULL DEFAULT 1,
  email_enabled INTEGER NOT NULL DEFAULT 0,
  email_recipients TEXT NOT NULL DEFAULT '[]',
  last_sent_on TEXT,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_wilaya_created ON orders(wilaya_id, created_at);
