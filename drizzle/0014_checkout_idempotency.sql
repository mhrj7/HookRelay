ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS request_fingerprint text;
UPDATE commerce_orders SET idempotency_key = 'legacy-' || id, request_fingerprint = md5(id) WHERE idempotency_key IS NULL OR request_fingerprint IS NULL;
ALTER TABLE commerce_orders ALTER COLUMN idempotency_key SET NOT NULL;
ALTER TABLE commerce_orders ALTER COLUMN request_fingerprint SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS commerce_orders_buyer_id_idempotency_key_key ON commerce_orders(buyer_id, idempotency_key);

DROP FUNCTION IF EXISTS create_cart_checkout(text, text, text, integer, jsonb);
CREATE OR REPLACE FUNCTION create_cart_checkout(
  p_order_id text,
  p_payment_intent_id text,
  p_outbox_id text,
  p_buyer_id integer,
  p_idempotency_key text,
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
  v_fingerprint text;
  v_existing_order_id text;
  v_existing_fingerprint text;
  v_existing_total integer;
  v_existing_payment_intent_id text;
  v_existing_outbox_id text;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 16 OR length(p_idempotency_key) > 80 OR
    jsonb_typeof(p_reservation_ids) <> 'array' OR jsonb_array_length(p_reservation_ids) = 0 OR jsonb_array_length(p_reservation_ids) > 50 THEN
    RETURN jsonb_build_object('error', 'invalid');
  END IF;
  SELECT md5(string_agg(value, ',' ORDER BY value)) INTO v_fingerprint FROM jsonb_array_elements_text(p_reservation_ids);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_buyer_id::text || ':' || p_idempotency_key, 0));

  SELECT o.id, o.request_fingerprint, o.total, pi.id, oe.id
    INTO v_existing_order_id, v_existing_fingerprint, v_existing_total, v_existing_payment_intent_id, v_existing_outbox_id
  FROM commerce_orders o
  JOIN payment_intents pi ON pi.order_id = o.id
  JOIN outbox_events oe ON oe.aggregate_type = 'order' AND oe.aggregate_id = o.id AND oe.event_type = 'order.created'
  WHERE o.buyer_id = p_buyer_id AND o.idempotency_key = p_idempotency_key;
  IF v_existing_order_id IS NOT NULL THEN
    IF v_existing_fingerprint <> v_fingerprint THEN RETURN jsonb_build_object('error', 'key_conflict'); END IF;
    RETURN jsonb_build_object('orderId', v_existing_order_id, 'paymentIntentId', v_existing_payment_intent_id, 'outboxEventId', v_existing_outbox_id, 'total', v_existing_total, 'currency', 'INR', 'status', 'pending_payment', 'replayed', true);
  END IF;

  SELECT id INTO v_cart_id FROM carts WHERE buyer_id = p_buyer_id FOR UPDATE;
  IF v_cart_id IS NULL THEN RETURN jsonb_build_object('error', 'cart_empty'); END IF;
  PERFORM 1 FROM cart_items WHERE cart_id = v_cart_id ORDER BY variant_id FOR UPDATE;
  SELECT count(*)::integer INTO v_item_count FROM cart_items WHERE cart_id = v_cart_id;
  IF v_item_count = 0 THEN RETURN jsonb_build_object('error', 'cart_empty'); END IF;
  SELECT count(DISTINCT value)::integer INTO v_input_count FROM jsonb_array_elements_text(p_reservation_ids);
  IF v_input_count <> v_item_count OR jsonb_array_length(p_reservation_ids) <> v_item_count THEN RETURN jsonb_build_object('error', 'reservation_mismatch'); END IF;
  PERFORM r.id FROM inventory_reservations r WHERE r.id IN (SELECT value FROM jsonb_array_elements_text(p_reservation_ids)) ORDER BY r.id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM commerce_order_items oi WHERE oi.reservation_id IN (SELECT value FROM jsonb_array_elements_text(p_reservation_ids))) THEN RETURN jsonb_build_object('error', 'reservation_used'); END IF;

  SELECT count(*)::integer, coalesce(sum(v.price * ci.quantity), 0)::integer INTO v_valid_count, v_total
  FROM cart_items ci
  JOIN product_variants v ON v.id = ci.variant_id JOIN products p ON p.id = v.product_id
  JOIN stores s ON s.id = p.store_id JOIN users owner ON owner.id = s.owner_id
  JOIN inventory_reservations r ON r.variant_id = ci.variant_id AND r.id IN (SELECT value FROM jsonb_array_elements_text(p_reservation_ids))
  WHERE ci.cart_id = v_cart_id AND v.status = 'active' AND p.status = 'active' AND s.is_public
    AND (owner.seller_approval_status = 'approved' OR owner.role = 'admin') AND s.owner_id <> p_buyer_id
    AND r.buyer_id = p_buyer_id AND r.quantity = ci.quantity AND r.unit_price = v.price
    AND r.expires_at > CURRENT_TIMESTAMP AND r.released_at IS NULL AND v.price > 0;
  IF v_valid_count <> v_item_count THEN RETURN jsonb_build_object('error', 'reservation_mismatch'); END IF;

  INSERT INTO commerce_orders(id, buyer_id, idempotency_key, request_fingerprint, total) VALUES (p_order_id, p_buyer_id, p_idempotency_key, v_fingerprint, v_total);
  INSERT INTO commerce_order_items(order_id, variant_id, reservation_id, store_id, seller_id, quantity, unit_price, line_total)
    SELECT p_order_id, ci.variant_id, r.id, s.id, s.owner_id, ci.quantity, v.price, ci.quantity * v.price
    FROM cart_items ci JOIN product_variants v ON v.id = ci.variant_id JOIN products p ON p.id = v.product_id JOIN stores s ON s.id = p.store_id
    JOIN inventory_reservations r ON r.variant_id = ci.variant_id AND r.buyer_id = p_buyer_id AND r.id IN (SELECT value FROM jsonb_array_elements_text(p_reservation_ids))
    WHERE ci.cart_id = v_cart_id;
  INSERT INTO payment_intents(id, order_id, amount) VALUES (p_payment_intent_id, p_order_id, v_total);
  INSERT INTO outbox_events(id, aggregate_type, aggregate_id, event_type, payload)
    VALUES (p_outbox_id, 'order', p_order_id, 'order.created', jsonb_build_object('orderId', p_order_id, 'buyerId', p_buyer_id, 'total', v_total, 'currency', 'INR', 'itemCount', v_item_count)::text);
  DELETE FROM cart_items WHERE cart_id = v_cart_id;
  RETURN jsonb_build_object('orderId', p_order_id, 'paymentIntentId', p_payment_intent_id, 'outboxEventId', p_outbox_id, 'total', v_total, 'currency', 'INR', 'status', 'pending_payment', 'replayed', false);
END;
$$;
