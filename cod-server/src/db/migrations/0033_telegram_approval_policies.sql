CREATE TABLE IF NOT EXISTS telegram_approval_policies (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, action)
);

CREATE INDEX IF NOT EXISTS telegram_approval_policies_user_idx
  ON telegram_approval_policies(user_id, enabled);
