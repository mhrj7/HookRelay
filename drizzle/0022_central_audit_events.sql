CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY,
  actor_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_role text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  before_summary jsonb NOT NULL,
  after_summary jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_type text NOT NULL,
  source_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT audit_events_actor_role_check CHECK (actor_role IN ('buyer', 'seller', 'seller_staff', 'admin')),
  CONSTRAINT audit_events_action_check CHECK (length(trim(action)) > 0),
  CONSTRAINT audit_events_target_check CHECK (length(trim(target_type)) > 0 AND length(trim(target_id)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_events_source ON audit_events(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor_created ON audit_events(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_target_created ON audit_events(target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_action_created ON audit_events(action, created_at DESC);

CREATE OR REPLACE FUNCTION reject_audit_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events are immutable';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_immutable ON audit_events;
CREATE TRIGGER audit_events_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();

CREATE OR REPLACE FUNCTION mirror_seller_approval_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_actor_id integer := COALESCE(NEW.admin_id, NEW.seller_id);
  v_actor_role text;
BEGIN
  SELECT role INTO v_actor_role FROM users WHERE id = v_actor_id;
  INSERT INTO audit_events (
    id, actor_id, actor_role, action, target_type, target_id,
    before_summary, after_summary, metadata, source_type, source_id, created_at
  ) VALUES (
    'seller-approval:' || NEW.id,
    v_actor_id,
    v_actor_role,
    'seller.approval.' || NEW.action,
    'user',
    NEW.seller_id::text,
    jsonb_build_object('approvalStatus', NEW.previous_status),
    jsonb_build_object('approvalStatus', NEW.next_status),
    jsonb_build_object('sellerId', NEW.seller_id),
    'seller_approval_audits',
    NEW.id,
    NEW.created_at::timestamptz
  ) ON CONFLICT (source_type, source_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS seller_approval_audits_to_central ON seller_approval_audits;
CREATE TRIGGER seller_approval_audits_to_central
AFTER INSERT ON seller_approval_audits
FOR EACH ROW EXECUTE FUNCTION mirror_seller_approval_audit();

CREATE OR REPLACE FUNCTION mirror_inventory_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_events (
    id, actor_id, actor_role, action, target_type, target_id,
    before_summary, after_summary, metadata, source_type, source_id, created_at
  ) VALUES (
    'inventory:' || NEW.id,
    NEW.actor_id,
    NEW.actor_role,
    'inventory.stock.changed',
    'warehouse_stock',
    NEW.warehouse_id || ':' || NEW.variant_id,
    jsonb_build_object('quantity', NEW.previous_quantity, 'version', NEW.stock_version - 1),
    jsonb_build_object('quantity', NEW.quantity, 'version', NEW.stock_version),
    jsonb_build_object('storeId', NEW.store_id, 'warehouseId', NEW.warehouse_id, 'variantId', NEW.variant_id, 'sku', NEW.sku, 'reason', NEW.reason),
    'inventory_audits',
    NEW.id,
    NEW.created_at::timestamptz
  ) ON CONFLICT (source_type, source_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_audits_to_central ON inventory_audits;
CREATE TRIGGER inventory_audits_to_central
AFTER INSERT ON inventory_audits
FOR EACH ROW EXECUTE FUNCTION mirror_inventory_audit();

CREATE OR REPLACE FUNCTION mirror_refund_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_metadata jsonb;
BEGIN
  BEGIN
    v_metadata := NEW.metadata::jsonb;
  EXCEPTION WHEN others THEN
    v_metadata := jsonb_build_object('raw', NEW.metadata);
  END;

  INSERT INTO audit_events (
    id, actor_id, actor_role, action, target_type, target_id,
    before_summary, after_summary, metadata, source_type, source_id, created_at
  ) SELECT
    'refund:' || NEW.id,
    NEW.actor_id,
    u.role,
    NEW.event_type,
    'refund',
    NEW.refund_id,
    jsonb_build_object('status', NEW.from_status),
    jsonb_build_object('status', NEW.to_status),
    v_metadata,
    'refund_audits',
    NEW.id,
    NEW.created_at
  FROM users u WHERE u.id = NEW.actor_id
  ON CONFLICT (source_type, source_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refund_audits_to_central ON refund_audits;
CREATE TRIGGER refund_audits_to_central
AFTER INSERT ON refund_audits
FOR EACH ROW EXECUTE FUNCTION mirror_refund_audit();

INSERT INTO audit_events (
  id, actor_id, actor_role, action, target_type, target_id,
  before_summary, after_summary, metadata, source_type, source_id, created_at
)
SELECT
  'seller-approval:' || a.id,
  COALESCE(a.admin_id, a.seller_id),
  actor.role,
  'seller.approval.' || a.action,
  'user',
  a.seller_id::text,
  jsonb_build_object('approvalStatus', a.previous_status),
  jsonb_build_object('approvalStatus', a.next_status),
  jsonb_build_object('sellerId', a.seller_id, 'legacyBackfill', true),
  'seller_approval_audits',
  a.id,
  a.created_at::timestamptz
FROM seller_approval_audits a
JOIN users actor ON actor.id = COALESCE(a.admin_id, a.seller_id)
ON CONFLICT (source_type, source_id) DO NOTHING;

INSERT INTO audit_events (
  id, actor_id, actor_role, action, target_type, target_id,
  before_summary, after_summary, metadata, source_type, source_id, created_at
)
SELECT
  'inventory:' || a.id,
  a.actor_id,
  a.actor_role,
  'inventory.stock.changed',
  'warehouse_stock',
  a.warehouse_id || ':' || a.variant_id,
  jsonb_build_object('quantity', a.previous_quantity, 'version', a.stock_version - 1),
  jsonb_build_object('quantity', a.quantity, 'version', a.stock_version),
  jsonb_build_object('storeId', a.store_id, 'warehouseId', a.warehouse_id, 'variantId', a.variant_id, 'sku', a.sku, 'reason', a.reason, 'legacyBackfill', true),
  'inventory_audits',
  a.id,
  a.created_at::timestamptz
FROM inventory_audits a
ON CONFLICT (source_type, source_id) DO NOTHING;

INSERT INTO audit_events (
  id, actor_id, actor_role, action, target_type, target_id,
  before_summary, after_summary, metadata, source_type, source_id, created_at
)
SELECT
  'refund:' || a.id,
  a.actor_id,
  actor.role,
  a.event_type,
  'refund',
  a.refund_id,
  jsonb_build_object('status', a.from_status),
  jsonb_build_object('status', a.to_status),
  CASE WHEN a.metadata ~ '^\s*[\{\[]' THEN a.metadata::jsonb ELSE jsonb_build_object('raw', a.metadata) END || jsonb_build_object('legacyBackfill', true),
  'refund_audits',
  a.id,
  a.created_at
FROM refund_audits a
JOIN users actor ON actor.id = a.actor_id
ON CONFLICT (source_type, source_id) DO NOTHING;
