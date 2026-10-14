ALTER TABLE inventory_reservations ADD COLUMN IF NOT EXISTS released_at timestamptz;
ALTER TABLE inventory_reservations ADD COLUMN IF NOT EXISTS release_reason text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_reservations_release_check') THEN
    ALTER TABLE inventory_reservations ADD CONSTRAINT inventory_reservations_release_check CHECK (
      (released_at IS NULL AND release_reason IS NULL)
      OR (released_at IS NOT NULL AND release_reason = 'payment_failed')
    );
  END IF;
END;
$$;

-- The failure transition locks the reservation and is idempotent. Allocations
-- remain as an audit record; every availability query ignores released holds.
CREATE OR REPLACE FUNCTION release_inventory_after_payment_failure(p_id text, p_buyer integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  existing inventory_reservations%ROWTYPE;
  instant timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_buyer AND role IN ('buyer', 'seller')) THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  SELECT * INTO existing FROM inventory_reservations
    WHERE id = p_id AND buyer_id = p_buyer FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF existing.released_at IS NOT NULL THEN
    RETURN jsonb_build_object('id', existing.id, 'status', 'released');
  END IF;
  instant := clock_timestamp();
  IF existing.expires_at <= instant THEN
    RETURN jsonb_build_object('id', existing.id, 'status', 'expired');
  END IF;
  UPDATE inventory_reservations SET released_at = instant, release_reason = 'payment_failed'
    WHERE id = existing.id;
  RETURN jsonb_build_object('id', existing.id, 'status', 'released');
END;
$$;

-- Reinstall reservation creation with released reservations excluded from every
-- active-hold and free-stock calculation.
CREATE OR REPLACE FUNCTION reserve_inventory(p_id text, p_buyer integer, p_variant text, p_quantity integer, p_key text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  existing inventory_reservations%ROWTYPE;
  item record;
  location record;
  remaining integer;
  take integer;
  available integer;
  instant timestamptz;
BEGIN
  IF p_quantity IS NULL OR p_quantity NOT BETWEEN 1 AND 20 OR p_key IS NULL OR length(p_key) NOT BETWEEN 16 AND 80 THEN
    RETURN jsonb_build_object('error', 'invalid');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_buyer::text || ':' || p_key, 0));
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_buyer AND role IN ('buyer', 'seller')) THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  SELECT * INTO existing FROM inventory_reservations WHERE buyer_id = p_buyer AND idempotency_key = p_key;
  IF FOUND THEN
    IF existing.variant_id <> p_variant OR existing.quantity <> p_quantity THEN
      RETURN jsonb_build_object('error', 'key_conflict');
    END IF;
    RETURN jsonb_build_object('id', existing.id);
  END IF;
  PERFORM 1 FROM product_variants WHERE id = p_variant FOR UPDATE;
  SELECT v.price, s.owner_id INTO item FROM product_variants v
    JOIN products p ON p.id = v.product_id JOIN stores s ON s.id = p.store_id
    JOIN users u ON u.id = s.owner_id
    WHERE v.id = p_variant AND v.status = 'active' AND p.status = 'active'
      AND s.is_public AND (u.seller_approval_status = 'approved' OR u.role = 'admin') AND v.price > 0;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF item.owner_id = p_buyer THEN RETURN jsonb_build_object('error', 'own_store'); END IF;
  instant := clock_timestamp();
  SELECT * INTO existing FROM inventory_reservations
    WHERE buyer_id = p_buyer AND variant_id = p_variant AND expires_at > instant AND released_at IS NULL LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('error', 'already_held', 'id', existing.id); END IF;
  SELECT coalesce(sum(greatest(0, stock.quantity - coalesce((
    SELECT sum(a.quantity) FROM inventory_reservation_allocations a JOIN inventory_reservations r ON r.id = a.reservation_id
    WHERE a.variant_id = stock.variant_id AND a.warehouse_id = stock.warehouse_id
      AND r.expires_at > instant AND r.released_at IS NULL
  ), 0))), 0)::integer INTO available FROM warehouse_stock stock WHERE stock.variant_id = p_variant;
  IF available < p_quantity THEN RETURN jsonb_build_object('error', 'insufficient', 'available', available); END IF;
  INSERT INTO inventory_reservations(id, buyer_id, variant_id, quantity, unit_price, idempotency_key, created_at, expires_at)
    VALUES(p_id, p_buyer, p_variant, p_quantity, item.price, p_key, instant, instant + interval '10 minutes');
  remaining := p_quantity;
  FOR location IN SELECT stock.warehouse_id, greatest(0, stock.quantity - coalesce((
      SELECT sum(a.quantity) FROM inventory_reservation_allocations a JOIN inventory_reservations r ON r.id = a.reservation_id
      WHERE a.variant_id = stock.variant_id AND a.warehouse_id = stock.warehouse_id
        AND r.expires_at > instant AND r.released_at IS NULL
    ), 0))::integer AS free FROM warehouse_stock stock WHERE stock.variant_id = p_variant ORDER BY stock.warehouse_id LOOP
    take := least(remaining, location.free);
    IF take > 0 THEN
      INSERT INTO inventory_reservation_allocations VALUES(p_id, location.warehouse_id, p_variant, take);
      remaining := remaining - take;
    END IF;
    EXIT WHEN remaining = 0;
  END LOOP;
  IF remaining <> 0 THEN RAISE EXCEPTION 'Reservation allocation invariant failed'; END IF;
  RETURN jsonb_build_object('id', p_id);
END;
$$;

CREATE OR REPLACE FUNCTION protect_reserved_inventory() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE held integer;
BEGIN
  PERFORM 1 FROM product_variants WHERE id = NEW.variant_id FOR UPDATE;
  SELECT coalesce(sum(a.quantity), 0)::integer INTO held FROM inventory_reservation_allocations a
    JOIN inventory_reservations r ON r.id = a.reservation_id
    WHERE a.variant_id = NEW.variant_id AND a.warehouse_id = NEW.warehouse_id
      AND r.expires_at > clock_timestamp() AND r.released_at IS NULL;
  IF NEW.quantity < held THEN
    RAISE EXCEPTION 'Stock cannot be lower than active reservations' USING ERRCODE = 'P0022';
  END IF;
  RETURN NEW;
END;
$$;
