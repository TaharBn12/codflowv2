ALTER TABLE operation_agent_settings ADD COLUMN confirmation_commission_type TEXT NOT NULL DEFAULT 'fixed' CHECK (confirmation_commission_type IN ('fixed', 'percentage'));
ALTER TABLE operation_agent_settings ADD COLUMN confirmation_commission_value REAL NOT NULL DEFAULT 0;

CREATE TABLE staff_commission_events (
  id TEXT PRIMARY KEY NOT NULL,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('confirmation', 'follow_up')),
  amount REAL NOT NULL,
  rate_type TEXT NOT NULL CHECK (rate_type IN ('fixed', 'percentage')),
  rate_value REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'earned', 'paid', 'reversed')),
  earned_at TEXT,
  paid_at TEXT,
  reversed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX staff_commission_events_order_category_idx ON staff_commission_events(order_id, category);
CREATE INDEX staff_commission_events_user_status_idx ON staff_commission_events(user_id, status, created_at);
INSERT OR IGNORE INTO staff_commission_events (id, order_id, user_id, category, amount, rate_type, rate_value, status, earned_at, paid_at, reversed_at, created_at, updated_at)
SELECT id, order_id, user_id, 'follow_up', amount, rate_type, rate_value, status, earned_at, paid_at, reversed_at, created_at, updated_at FROM staff_commissions;

CREATE TABLE telegram_approval_config (
  id TEXT PRIMARY KEY NOT NULL DEFAULT 'default',
  bot_token TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  webhook_secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
