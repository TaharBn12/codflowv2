-- Admin-controlled global switch for automatic confirmation assignment.
-- Per-agent participation and workload limits remain in operation_agent_settings.
CREATE TABLE operation_automation_settings (
  id TEXT PRIMARY KEY NOT NULL DEFAULT 'default',
  auto_assign_enabled INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO operation_automation_settings (id, auto_assign_enabled, created_at, updated_at)
VALUES ('default', 1, datetime('now'), datetime('now'));
