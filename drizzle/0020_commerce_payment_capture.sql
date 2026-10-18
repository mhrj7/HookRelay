ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS provider_order_id text;
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS provider_payment_id text;
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS provider_response text;
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_provider_order_id_key ON payment_intents(provider_order_id) WHERE provider_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_provider_payment_id_key ON payment_intents(provider_payment_id) WHERE provider_payment_id IS NOT NULL;

ALTER TABLE inventory_reservations DROP CONSTRAINT IF EXISTS inventory_reservations_release_check;
ALTER TABLE inventory_reservations ADD CONSTRAINT inventory_reservations_release_check CHECK (
  (released_at IS NULL AND release_reason IS NULL) OR
  (released_at IS NOT NULL AND release_reason IN ('payment_failed', 'order_cancelled', 'payment_succeeded'))
);

CREATE OR REPLACE FUNCTION begin_commerce_payment(p_order_id text, p_buyer_id integer, p_provider text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_order commerce_orders%ROWTYPE; v_intent payment_intents%ROWTYPE;
BEGIN
  IF p_provider NOT IN ('internal_test', 'razorpay_test') THEN RETURN jsonb_build_object('error', 'invalid_provider'); END IF;
  SELECT * INTO v_order FROM commerce_orders WHERE id = p_order_id AND buyer_id = p_buyer_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  SELECT * INTO v_intent FROM payment_intents WHERE order_id = p_order_id FOR UPDATE;
  IF v_order.status = 'paid' AND v_intent.status = 'succeeded' THEN
    RETURN jsonb_build_object('orderId', v_order.id, 'paymentIntentId', v_intent.id, 'status', 'succeeded', 'provider', v_intent.provider, 'providerOrderId', v_intent.provider_order_id, 'amount', v_intent.amount, 'currency', v_intent.currency, 'replayed', true);
  END IF;
  IF v_order.status <> 'pending_payment' OR v_intent.status NOT IN ('requires_payment_method', 'creating', 'requires_action') THEN RETURN jsonb_build_object('error', 'invalid_state'); END IF;
  IF v_intent.provider_order_id IS NOT NULL THEN
    RETURN jsonb_build_object('orderId', v_order.id, 'paymentIntentId', v_intent.id, 'status', v_intent.status, 'provider', v_intent.provider, 'providerOrderId', v_intent.provider_order_id, 'amount', v_intent.amount, 'currency', v_intent.currency, 'replayed', true);
  END IF;
  IF v_intent.status = 'creating' THEN RETURN jsonb_build_object('error', 'in_progress'); END IF;
  UPDATE payment_intents SET provider = p_provider, status = 'creating', updated_at = clock_timestamp() WHERE id = v_intent.id;
  RETURN jsonb_build_object('orderId', v_order.id, 'paymentIntentId', v_intent.id, 'status', 'creating', 'provider', p_provider, 'amount', v_intent.amount, 'currency', v_intent.currency, 'replayed', false);
END $$;

CREATE OR REPLACE FUNCTION store_commerce_payment_order(p_intent_id text, p_provider_order_id text, p_provider_response text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_intent payment_intents%ROWTYPE;
BEGIN
  SELECT * INTO v_intent FROM payment_intents WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_intent.provider_order_id IS NOT NULL THEN
    IF v_intent.provider_order_id <> p_provider_order_id THEN RETURN jsonb_build_object('error', 'provider_conflict'); END IF;
  ELSIF v_intent.status = 'creating' THEN
    UPDATE payment_intents SET provider_order_id = p_provider_order_id, provider_response = p_provider_response, status = 'requires_action', updated_at = clock_timestamp() WHERE id = p_intent_id RETURNING * INTO v_intent;
  ELSE RETURN jsonb_build_object('error', 'invalid_state');
  END IF;
  RETURN jsonb_build_object('orderId', v_intent.order_id, 'paymentIntentId', v_intent.id, 'provider', v_intent.provider, 'providerOrderId', v_intent.provider_order_id, 'amount', v_intent.amount, 'currency', v_intent.currency, 'status', v_intent.status);
END $$;

CREATE OR REPLACE FUNCTION capture_commerce_payment(
  p_order_id text, p_buyer_id integer, p_provider_order_id text, p_provider_payment_id text,
  p_provider_response text, p_outbox_id text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_order commerce_orders%ROWTYPE; v_intent payment_intents%ROWTYPE; v_now timestamptz := clock_timestamp(); v_event_id text; v_item record;
BEGIN
  SELECT * INTO v_order FROM commerce_orders WHERE id = p_order_id AND buyer_id = p_buyer_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  SELECT * INTO v_intent FROM payment_intents WHERE order_id = p_order_id FOR UPDATE;
  IF v_order.status = 'paid' AND v_intent.status = 'succeeded' THEN
    IF v_intent.provider_order_id <> p_provider_order_id OR v_intent.provider_payment_id <> p_provider_payment_id THEN RETURN jsonb_build_object('error', 'provider_conflict'); END IF;
    SELECT id INTO v_event_id FROM outbox_events WHERE aggregate_type = 'order' AND aggregate_id = p_order_id AND event_type = 'order.paid';
    RETURN jsonb_build_object('orderId', p_order_id, 'paymentIntentId', v_intent.id, 'status', 'paid', 'outboxEventId', v_event_id, 'replayed', true);
  END IF;
  IF v_order.status <> 'pending_payment' OR v_intent.status <> 'requires_action' OR v_intent.provider_order_id <> p_provider_order_id THEN RETURN jsonb_build_object('error', 'invalid_state'); END IF;

  PERFORM 1 FROM product_variants WHERE id IN (SELECT variant_id FROM commerce_order_items WHERE order_id = p_order_id) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM inventory_reservations WHERE id IN (SELECT reservation_id FROM commerce_order_items WHERE order_id = p_order_id) ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM commerce_order_items oi JOIN inventory_reservations r ON r.id = oi.reservation_id WHERE oi.order_id = p_order_id AND (r.expires_at <= v_now OR r.released_at IS NOT NULL)) THEN
    UPDATE payment_intents SET status = 'requires_reconciliation', provider_payment_id = p_provider_payment_id, provider_response = p_provider_response, updated_at = v_now WHERE id = v_intent.id;
    UPDATE commerce_orders SET status = 'payment_review', updated_at = v_now WHERE id = p_order_id;
    RETURN jsonb_build_object('error', 'reservation_expired', 'status', 'payment_review');
  END IF;
  PERFORM 1 FROM warehouse_stock ws WHERE (ws.warehouse_id, ws.variant_id) IN (
    SELECT a.warehouse_id, a.variant_id FROM inventory_reservation_allocations a JOIN commerce_order_items oi ON oi.reservation_id = a.reservation_id WHERE oi.order_id = p_order_id
  ) ORDER BY ws.variant_id, ws.warehouse_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM inventory_reservation_allocations a JOIN commerce_order_items oi ON oi.reservation_id = a.reservation_id
    JOIN warehouse_stock ws ON ws.warehouse_id = a.warehouse_id AND ws.variant_id = a.variant_id
    WHERE oi.order_id = p_order_id AND ws.quantity < a.quantity
  ) THEN RAISE EXCEPTION 'Reserved stock invariant failed'; END IF;

  UPDATE inventory_reservations SET released_at = v_now, release_reason = 'payment_succeeded'
  WHERE id IN (SELECT reservation_id FROM commerce_order_items WHERE order_id = p_order_id);
  FOR v_item IN SELECT a.warehouse_id, a.variant_id, a.quantity FROM inventory_reservation_allocations a JOIN commerce_order_items oi ON oi.reservation_id = a.reservation_id WHERE oi.order_id = p_order_id ORDER BY a.variant_id, a.warehouse_id LOOP
    UPDATE warehouse_stock SET quantity = quantity - v_item.quantity, version = version + 1, updated_at = v_now WHERE warehouse_id = v_item.warehouse_id AND variant_id = v_item.variant_id;
  END LOOP;
  UPDATE payment_intents SET status = 'succeeded', provider_payment_id = p_provider_payment_id, provider_response = p_provider_response, updated_at = v_now WHERE id = v_intent.id;
  UPDATE commerce_orders SET status = 'paid', updated_at = v_now WHERE id = p_order_id;
  INSERT INTO outbox_events(id, aggregate_type, aggregate_id, event_type, payload) VALUES (p_outbox_id, 'order', p_order_id, 'order.paid', jsonb_build_object('orderId', p_order_id, 'paymentIntentId', v_intent.id, 'amount', v_intent.amount, 'currency', v_intent.currency)::text) RETURNING id INTO v_event_id;
  RETURN jsonb_build_object('orderId', p_order_id, 'paymentIntentId', v_intent.id, 'status', 'paid', 'outboxEventId', v_event_id, 'replayed', false);
END $$;
