-- Make the outbox/domain relationship a deferred database invariant. The
-- existing checkout, payment, cancellation and refund functions may write
-- their rows in sequence, but PostgreSQL checks the final state at COMMIT.

CREATE OR REPLACE FUNCTION assert_order_outbox_consistency(p_order_id text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_order commerce_orders%ROWTYPE;
  v_payment payment_intents%ROWTYPE;
  v_refund refunds%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM commerce_orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM outbox_events WHERE aggregate_type = 'order' AND aggregate_id = p_order_id) THEN
      RAISE EXCEPTION 'Outbox event references missing order %', p_order_id USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;

  SELECT * INTO v_payment FROM payment_intents WHERE order_id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % cannot commit without its payment intent', p_order_id USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM outbox_events
    WHERE aggregate_type = 'order' AND aggregate_id = p_order_id AND event_type = 'order.created'
  ) THEN
    RAISE EXCEPTION 'Order % cannot commit without order.created', p_order_id USING ERRCODE = '23514';
  END IF;

  IF v_order.status IN ('paid', 'refunded') AND v_payment.status IN ('succeeded', 'refunded')
     AND NOT EXISTS (
       SELECT 1 FROM outbox_events
       WHERE aggregate_type = 'order' AND aggregate_id = p_order_id AND event_type = 'order.paid'
     ) THEN
    RAISE EXCEPTION 'Paid order % cannot commit without order.paid', p_order_id USING ERRCODE = '23514';
  END IF;

  IF v_order.status = 'cancelled' AND v_payment.status = 'cancelled'
     AND NOT EXISTS (
       SELECT 1 FROM outbox_events
       WHERE aggregate_type = 'order' AND aggregate_id = p_order_id AND event_type = 'order.cancelled'
     ) THEN
    RAISE EXCEPTION 'Cancelled order % cannot commit without order.cancelled', p_order_id USING ERRCODE = '23514';
  END IF;

  IF v_order.status = 'refunded' THEN
    SELECT * INTO v_refund FROM refunds WHERE order_id = p_order_id AND payment_intent_id = v_payment.id;
    IF NOT FOUND OR v_refund.status <> 'succeeded' OR v_payment.status <> 'refunded' OR NOT EXISTS (
      SELECT 1 FROM outbox_events
      WHERE aggregate_type = 'order' AND aggregate_id = p_order_id AND event_type = 'order.refunded'
    ) THEN
      RAISE EXCEPTION 'Refunded order % requires succeeded refund, refunded payment and order.refunded', p_order_id USING ERRCODE = '23514';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM outbox_events e WHERE e.aggregate_type = 'order' AND e.aggregate_id = p_order_id AND (
      (e.event_type = 'order.paid' AND (v_order.status NOT IN ('paid', 'refunded') OR v_payment.status NOT IN ('succeeded', 'refunded'))) OR
      (e.event_type = 'order.cancelled' AND (v_order.status <> 'cancelled' OR v_payment.status <> 'cancelled')) OR
      (e.event_type = 'order.refunded' AND (v_order.status <> 'refunded' OR v_payment.status <> 'refunded' OR NOT EXISTS (
        SELECT 1 FROM refunds r WHERE r.order_id = p_order_id AND r.payment_intent_id = v_payment.id AND r.status = 'succeeded'
      )))
    )
  ) THEN
    RAISE EXCEPTION 'Order % has an outbox event without its matching domain state', p_order_id USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION check_order_outbox_consistency_trigger()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_order_id text;
  v_old_order_id text;
BEGIN
  IF TG_TABLE_NAME = 'outbox_events' THEN
    IF TG_OP <> 'INSERT' THEN v_old_order_id := OLD.aggregate_id; END IF;
    IF TG_OP <> 'DELETE' THEN v_order_id := NEW.aggregate_id; END IF;
  ELSIF TG_TABLE_NAME = 'refunds' OR TG_TABLE_NAME = 'payment_intents' THEN
    IF TG_OP <> 'INSERT' THEN v_old_order_id := OLD.order_id; END IF;
    IF TG_OP <> 'DELETE' THEN v_order_id := NEW.order_id; END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN v_old_order_id := OLD.id; END IF;
    IF TG_OP <> 'DELETE' THEN v_order_id := NEW.id; END IF;
  END IF;

  IF v_old_order_id IS NOT NULL THEN PERFORM assert_order_outbox_consistency(v_old_order_id); END IF;
  IF v_order_id IS NOT NULL AND v_order_id IS DISTINCT FROM v_old_order_id THEN
    PERFORM assert_order_outbox_consistency(v_order_id);
  ELSIF v_order_id IS NOT NULL AND v_old_order_id IS NULL THEN
    PERFORM assert_order_outbox_consistency(v_order_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS commerce_orders_outbox_consistency ON commerce_orders;
CREATE CONSTRAINT TRIGGER commerce_orders_outbox_consistency
AFTER INSERT OR UPDATE OR DELETE ON commerce_orders
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION check_order_outbox_consistency_trigger();

DROP TRIGGER IF EXISTS payment_intents_outbox_consistency ON payment_intents;
CREATE CONSTRAINT TRIGGER payment_intents_outbox_consistency
AFTER INSERT OR UPDATE OR DELETE ON payment_intents
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION check_order_outbox_consistency_trigger();

DROP TRIGGER IF EXISTS refunds_outbox_consistency ON refunds;
CREATE CONSTRAINT TRIGGER refunds_outbox_consistency
AFTER INSERT OR UPDATE OR DELETE ON refunds
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION check_order_outbox_consistency_trigger();

DROP TRIGGER IF EXISTS outbox_events_consistency ON outbox_events;
CREATE CONSTRAINT TRIGGER outbox_events_consistency
AFTER INSERT OR UPDATE OR DELETE ON outbox_events
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION check_order_outbox_consistency_trigger();

-- Refuse rollout if historical rows do not satisfy the invariant that will
-- be enforced for all subsequent transactions.
DO $$
DECLARE
  v_order_id text;
BEGIN
  FOR v_order_id IN SELECT id FROM commerce_orders LOOP
    PERFORM assert_order_outbox_consistency(v_order_id);
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM outbox_events e
    LEFT JOIN commerce_orders o ON e.aggregate_type = 'order' AND e.aggregate_id = o.id
    WHERE e.aggregate_type = 'order' AND o.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot install transactional outbox guards while orphan order events exist' USING ERRCODE = '23514';
  END IF;
END;
$$;
