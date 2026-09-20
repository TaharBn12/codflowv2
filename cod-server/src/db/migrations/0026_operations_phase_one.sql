-- Operations phase one: confirmation assignment, tasks and delivered commissions.
CREATE TABLE operation_agent_settings (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auto_assign_enabled INTEGER NOT NULL DEFAULT 1,
  max_open_orders INTEGER NOT NULL DEFAULT 25,
  commission_type TEXT NOT NULL DEFAULT 'fixed' CHECK (commission_type IN ('fixed', 'percentage')),
  commission_value REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

ALTER TABLE orders ADD COLUMN confirmation_assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN confirmation_assigned_at TEXT;

CREATE INDEX IF NOT EXISTS orders_confirmation_assignee_status_idx
  ON orders(confirmation_assignee_id, status, created_at);

CREATE TABLE operation_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL DEFAULT 'follow_up' CHECK (type IN ('confirmation', 'callback', 'address_review', 'shipment_follow_up', 'follow_up')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  order_id TEXT REFERENCES orders(id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  assignee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  due_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX operation_tasks_assignee_status_due_idx ON operation_tasks(assignee_id, status, due_at);
CREATE INDEX operation_tasks_order_idx ON operation_tasks(order_id);

CREATE TABLE staff_commissions (
  id TEXT PRIMARY KEY NOT NULL,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  rate_type TEXT NOT NULL CHECK (rate_type IN ('fixed', 'percentage')),
  rate_value REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'earned' CHECK (status IN ('earned', 'paid', 'reversed')),
  earned_at TEXT NOT NULL,
  paid_at TEXT,
  reversed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX staff_commissions_user_status_idx ON staff_commissions(user_id, status, earned_at);
