-- The existing 5% policy was only a test assumption. Never invent a rate for
-- a previously settled order; leave it NULL for explicit reconciliation.
ALTER TABLE commerce_order_items ADD COLUMN IF NOT EXISTS commission_rate_bps integer;
UPDATE commerce_order_items AS item SET commission_rate_bps = 500
FROM commerce_orders AS orders
WHERE item.order_id = orders.id AND orders.status = 'pending_payment' AND item.commission_rate_bps IS NULL;
ALTER TABLE commerce_order_items ALTER COLUMN commission_rate_bps SET DEFAULT 500;
DO $$ BEGIN
  ALTER TABLE commerce_order_items ADD CONSTRAINT commerce_order_items_commission_rate_check CHECK (commission_rate_bps BETWEEN 0 AND 10000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Snapshot cannot be silently rewritten when the policy changes in future.
CREATE OR REPLACE FUNCTION preserve_item_commission_rate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.commission_rate_bps IS DISTINCT FROM NEW.commission_rate_bps AND OLD.commission_rate_bps IS NOT NULL THEN
    RAISE EXCEPTION 'An order item commission rate cannot be changed after checkout';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS preserve_item_commission_rate ON commerce_order_items;
CREATE TRIGGER preserve_item_commission_rate BEFORE UPDATE OF commission_rate_bps ON commerce_order_items
FOR EACH ROW EXECUTE FUNCTION preserve_item_commission_rate();
