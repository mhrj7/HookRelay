ALTER TABLE commerce_orders ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

ALTER TABLE inventory_reservations DROP CONSTRAINT IF EXISTS inventory_reservations_release_check;
ALTER TABLE inventory_reservations ADD CONSTRAINT inventory_reservations_release_check CHECK (
  (released_at IS NULL AND release_reason IS NULL) OR
  (released_at IS NOT NULL AND release_reason IN ('payment_failed', 'order_cancelled'))
);

CREATE OR REPLACE FUNCTION cancel_commerce_order(
  p_order_id text,
  p_buyer_id integer,
  p_outbox_id text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_status text;
  v_payment_status text;
  v_cancelled_at timestamptz;
  v_event_id text;
  v_released_quantity integer := 0;
BEGIN
  SELECT status, cancelled_at INTO v_status, v_cancelled_at
  FROM commerce_orders
  WHERE id = p_order_id AND buyer_id = p_buyer_id
  FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;

  IF v_status = 'cancelled' THEN
    SELECT id, (payload::jsonb->>'releasedQuantity')::integer INTO v_event_id, v_released_quantity FROM outbox_events
    WHERE aggregate_type = 'order' AND aggregate_id = p_order_id AND event_type = 'order.cancelled';
    RETURN jsonb_build_object(
      'orderId', p_order_id,
      'status', 'cancelled',
      'cancelledAt', v_cancelled_at,
      'outboxEventId', v_event_id,
      'releasedQuantity', v_released_quantity,
      'replayed', true
    );
  END IF;

  IF v_status <> 'pending_payment' THEN RETURN jsonb_build_object('error', 'invalid_state'); END IF;

  SELECT status INTO v_payment_status FROM payment_intents WHERE order_id = p_order_id FOR UPDATE;
  IF v_payment_status IS DISTINCT FROM 'requires_payment_method' THEN
    RETURN jsonb_build_object('error', 'invalid_state');
  END IF;

  SELECT coalesce(sum(a.quantity), 0)::integer INTO v_released_quantity
  FROM commerce_order_items oi
  JOIN inventory_reservations r ON r.id = oi.reservation_id
  JOIN inventory_reservation_allocations a ON a.reservation_id = r.id
  WHERE oi.order_id = p_order_id AND r.released_at IS NULL AND r.expires_at > CURRENT_TIMESTAMP;

  UPDATE inventory_reservations r
  SET released_at = clock_timestamp(), release_reason = 'order_cancelled'
  WHERE r.id IN (SELECT reservation_id FROM commerce_order_items WHERE order_id = p_order_id)
    AND r.released_at IS NULL AND r.expires_at > CURRENT_TIMESTAMP;

  UPDATE payment_intents SET status = 'cancelled'
  WHERE order_id = p_order_id AND status = 'requires_payment_method';

  UPDATE commerce_orders
  SET status = 'cancelled', cancelled_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE id = p_order_id
  RETURNING cancelled_at INTO v_cancelled_at;

  INSERT INTO outbox_events(id, aggregate_type, aggregate_id, event_type, payload)
  VALUES (
    p_outbox_id,
    'order',
    p_order_id,
    'order.cancelled',
    jsonb_build_object('orderId', p_order_id, 'buyerId', p_buyer_id, 'releasedQuantity', v_released_quantity)::text
  )
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'orderId', p_order_id,
    'status', 'cancelled',
    'cancelledAt', v_cancelled_at,
    'outboxEventId', v_event_id,
    'releasedQuantity', v_released_quantity,
    'replayed', false
  );
END;
$$;
