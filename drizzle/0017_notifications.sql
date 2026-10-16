CREATE TABLE IF NOT EXISTS notifications (
  id text PRIMARY KEY,
  recipient_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  event_type text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('in_app', 'email')),
  title text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'skipped')),
  provider_message_id text,
  failure_reason text,
  read_at text,
  delivered_at text,
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
  CONSTRAINT notifications_recipient_event_channel_key UNIQUE (recipient_id, event_key, channel)
);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created ON notifications(recipient_id, created_at);
