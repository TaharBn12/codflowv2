CREATE TABLE admin_approval_requests (
  id TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL,
  title TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'failed')),
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by_name TEXT NOT NULL,
  decided_by_telegram_id TEXT,
  decision_note TEXT,
  telegram_message_id TEXT,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX admin_approvals_status_expiry_idx ON admin_approval_requests(status, expires_at);
