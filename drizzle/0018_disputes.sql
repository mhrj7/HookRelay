CREATE TABLE IF NOT EXISTS disputes (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  opened_by integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'under_review', 'resolved', 'rejected')),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 5 AND 500),
  resolution text,
  resolved_by integer REFERENCES users(id) ON DELETE RESTRICT,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT disputes_resolution_check CHECK (
    (status IN ('open', 'under_review') AND resolution IS NULL AND resolved_by IS NULL AND resolved_at IS NULL)
    OR
    (status IN ('resolved', 'rejected') AND length(trim(resolution)) BETWEEN 5 AND 1000 AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS disputes_order_id_key ON disputes(order_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status_updated ON disputes(status, updated_at);
