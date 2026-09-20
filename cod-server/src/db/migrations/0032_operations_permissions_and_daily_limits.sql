ALTER TABLE operation_agent_settings ADD COLUMN max_daily_orders INTEGER NOT NULL DEFAULT 50;

-- Preserve access for existing confirmation agents while allowing admins to
-- revoke or grant the Operations page independently in Team permissions.
INSERT OR IGNORE INTO user_scopes (id, user_id, scope, granted_at, granted_by)
SELECT lower(hex(randomblob(16))), id, 'operations:view', datetime('now'), NULL
FROM users
WHERE role = 'confirmer';
