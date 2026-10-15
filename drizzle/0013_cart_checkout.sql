CREATE TABLE IF NOT EXISTS commerce_orders (
  id text PRIMARY KEY,
  buyer_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending_payment',
  currency text NOT NULL DEFAULT 'INR',
  total integer NOT NULL CHECK (total > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_commerce_orders_buyer_created ON commerce_orders(buyer_id, created_at);

CREATE TABLE IF NOT EXISTS commerce_order_items (
  order_id text NOT NULL REFERENCES commerce_orders(id) ON DELETE CASCADE,
  variant_id text NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  reservation_id text NOT NULL REFERENCES inventory_reservations(id) ON DELETE RESTRICT,
  store_id text NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  seller_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  unit_price integer NOT NULL,
  line_total integer NOT NULL,
  PRIMARY KEY (order_id, variant_id),
  UNIQUE (reservation_id),
  CHECK (unit_price > 0 AND line_total = unit_price * quantity)
);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_order_items_reservation_id_key ON commerce_order_items(reservation_id);

CREATE TABLE IF NOT EXISTS payment_intents (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES commerce_orders(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'internal_test',
  status text NOT NULL DEFAULT 'requires_payment_method',
  amount integer NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'INR',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (order_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_order_id_key ON payment_intents(order_id);

CREATE TABLE IF NOT EXISTS outbox_events (
  id text PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  UNIQUE (aggregate_type, aggregate_id, event_type)
);
CREATE INDEX IF NOT EXISTS idx_outbox_events_status_created ON outbox_events(status, created_at);

CREATE OR REPLACE FUNCTION create_cart_checkout(
  p_order_id text,
  p_payment_intent_id text,
  p_outbox_id text,
  p_buyer_id integer,
  p_reservation_ids jsonb
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_cart_id text;
  v_item_count integer;
  v_input_count integer;
  v_valid_count integer;
  v_total integer;
BEGIN
  IF jsonb_typeof(p_reservation_ids) <> 'array' OR jsonb_array_length(p_reservation_ids) = 0 OR jsonb_array_length(p_reservation_ids) > 50 THEN
    RETURN jsonb_build_object('error', 'invalid');
  END IF;

  SELECT id INTO v_cart_id FROM carts WHERE buyer_id = p_buyer_id FOR UPDATE;
  IF v_cart_id IS NULL THEN RETURN jsonb_build_object('error', 'cart_empty'); END IF;
  PERFORM 1 FROM cart_items WHERE cart_id = v_cart_id ORDER BY variant_id FOR UPDATE;
  SELECT count(*)::integer INTO v_item_count FROM cart_items WHERE cart_id = v_cart_id;
  IF v_item_count = 0 THEN RETURN jsonb_build_object('error', 'cart_empty'); END IF;

  SELECT count(DISTINCT value)::integer INTO v_input_count FROM jsonb_array_elements_text(p_reservation_ids);
  IF v_input_count <> v_item_count OR jsonb_array_length(p_reservation_ids) <> v_item_count THEN
    RETURN jsonb_build_object('error', 'reservation_mismatch');
  END IF;

  PERFORM r.id FROM inventory_reservations r
    WHERE r.id IN (SELECT value FROM jsonb_array_elements_text(p_reservation_ids))
    ORDER BY r.id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM commerce_order_items oi
    WHERE oi.reservation_id IN (SELECT value FROM jsonb_array_elements_text(p_reservation_ids))
  ) THEN RETURN jsonb_build_object('error', 'reservation_used'); END IF;

  SELECT count(*)::integer, coalesce(sum(v.price * ci.quantity), 0)::integer
    INTO v_valid_count, v_total
  FROM cart_items ci
  JOIN product_variants v ON v.id = ci.variant_id
  JOIN products p ON p.id = v.product_id
  JOIN stores s ON s.id = p.store_id
  JOIN users owner ON owner.id = s.owner_id
  JOIN inventory_reservations r ON r.variant_id = ci.variant_id
    AND r.id IN (SELECT value FROM jsonb_array_elements_text(p_reservation_ids))
  WHERE ci.cart_id = v_cart_id AND v.status = 'active' AND p.status = 'active' AND s.is_public
    AND (owner.seller_approval_status = 'approved' OR owner.role = 'admin') AND s.owner_id <> p_buyer_id
    AND r.buyer_id = p_buyer_id AND r.quantity = ci.quantity AND r.unit_price = v.price
    AND r.expires_at > CURRENT_TIMESTAMP AND r.released_at IS NULL AND v.price > 0;
  IF v_valid_count <> v_item_count THEN RETURN jsonb_build_object('error', 'reservation_mismatch'); END IF;

  INSERT INTO commerce_orders(id, buyer_id, total) VALUES (p_order_id, p_buyer_id, v_total);
  INSERT INTO commerce_order_items(order_id, variant_id, reservation_id, store_id, seller_id, quantity, unit_price, line_total)
    SELECT p_order_id, ci.variant_id, r.id, s.id, s.owner_id, ci.quantity, v.price, ci.quantity * v.price
    FROM cart_items ci
    JOIN product_variants v ON v.id = ci.variant_id
    JOIN products p ON p.id = v.product_id
    JOIN stores s ON s.id = p.store_id
    JOIN inventory_reservations r ON r.variant_id = ci.variant_id AND r.buyer_id = p_buyer_id
      AND r.id IN (SELECT value FROM jsonb_array_elements_text(p_reservation_ids))
    WHERE ci.cart_id = v_cart_id;
  INSERT INTO payment_intents(id, order_id, amount) VALUES (p_payment_intent_id, p_order_id, v_total);
  INSERT INTO outbox_events(id, aggregate_type, aggregate_id, event_type, payload)
    VALUES (p_outbox_id, 'order', p_order_id, 'order.created', jsonb_build_object(
      'orderId', p_order_id, 'buyerId', p_buyer_id, 'total', v_total, 'currency', 'INR', 'itemCount', v_item_count
    )::text);
  DELETE FROM cart_items WHERE cart_id = v_cart_id;
  RETURN jsonb_build_object('orderId', p_order_id, 'paymentIntentId', p_payment_intent_id, 'outboxEventId', p_outbox_id, 'total', v_total, 'currency', 'INR', 'status', 'pending_payment');
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('error', 'conflict');
END;
$$;
