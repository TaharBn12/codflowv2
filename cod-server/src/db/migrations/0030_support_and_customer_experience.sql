-- Phase 2: unified WhatsApp/email support, tickets, secure customer order links.
CREATE TABLE support_channels (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('whatsapp', 'email')),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  provider TEXT NOT NULL,
  sender_id TEXT,
  access_token TEXT,
  verify_token TEXT,
  app_secret TEXT,
  webhook_secret TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX support_channels_type_idx ON support_channels(type);

CREATE TABLE support_conversations (
  id TEXT PRIMARY KEY NOT NULL,
  channel_id TEXT NOT NULL REFERENCES support_channels(id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  contact TEXT NOT NULL,
  contact_name TEXT,
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX support_conversations_status_last_idx ON support_conversations(status, last_message_at);
CREATE INDEX support_conversations_assignee_idx ON support_conversations(assignee_id, status);
CREATE INDEX support_conversations_contact_idx ON support_conversations(contact);

CREATE TABLE support_messages (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal')),
  channel_type TEXT NOT NULL CHECK (channel_type IN ('whatsapp', 'email')),
  sender_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  external_id TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'queued' CHECK (delivery_status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'received')),
  error_code TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX support_messages_external_idx ON support_messages(channel_type, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX support_messages_conversation_idx ON support_messages(conversation_id, created_at);

CREATE TABLE support_tickets (
  id TEXT PRIMARY KEY NOT NULL,
  ticket_number TEXT NOT NULL UNIQUE,
  conversation_id TEXT REFERENCES support_conversations(id) ON DELETE SET NULL,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'waiting_customer', 'resolved', 'closed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  due_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX support_tickets_status_priority_idx ON support_tickets(status, priority, created_at);
CREATE INDEX support_tickets_assignee_idx ON support_tickets(assignee_id, status);

CREATE TABLE customer_order_links (
  id TEXT PRIMARY KEY NOT NULL,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_viewed_at TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX customer_order_links_order_idx ON customer_order_links(order_id, expires_at);
