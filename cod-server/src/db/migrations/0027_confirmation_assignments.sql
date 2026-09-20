-- Dedicated confirmation-team assignment ledger. Kept separate from delivery assignment.
CREATE TABLE order_confirmation_assignments (
  order_id TEXT PRIMARY KEY NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  assignee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX order_confirmation_assignee_idx ON order_confirmation_assignments(assignee_id, assigned_at);
