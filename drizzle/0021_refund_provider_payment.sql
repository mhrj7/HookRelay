-- Refund the gateway payment, never the application's payment-intent UUID.
CREATE OR REPLACE FUNCTION begin_order_refund(
  p_refund_id text, p_order_id text, p_actor_id integer, p_idempotency_key text, p_reason text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_order_status text; v_order_total integer; v_currency text; v_intent_id text;
  v_intent_status text; v_provider text; v_provider_payment_id text; v_outbox_id text;
  v_existing refunds%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 16 OR length(p_idempotency_key) > 80 OR p_reason IS NULL OR length(trim(p_reason)) < 5 OR length(trim(p_reason)) > 240 THEN RETURN jsonb_build_object('error', 'invalid'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('refund:' || p_order_id, 0));
  SELECT * INTO v_existing FROM refunds WHERE requested_by = p_actor_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.order_id <> p_order_id THEN RETURN jsonb_build_object('error', 'key_conflict'); END IF;
    SELECT provider_payment_id INTO v_provider_payment_id FROM payment_intents WHERE id = v_existing.payment_intent_id;
    IF v_existing.status = 'succeeded' THEN
      SELECT id INTO v_outbox_id FROM outbox_events WHERE aggregate_type = 'order' AND aggregate_id = v_existing.order_id AND event_type = 'order.refunded';
    END IF;
    RETURN jsonb_build_object('refundId', v_existing.id, 'paymentIntentId', v_existing.payment_intent_id, 'providerPaymentId', v_provider_payment_id,
      'provider', v_existing.provider, 'providerRefundId', v_existing.provider_refund_id, 'amount', v_existing.amount, 'currency', v_existing.currency,
      'reason', v_existing.reason, 'status', v_existing.status, 'completedAt', v_existing.completed_at, 'outboxEventId', v_outbox_id, 'replayed', v_existing.status = 'succeeded');
  END IF;
  IF EXISTS (SELECT 1 FROM refunds WHERE order_id = p_order_id) THEN RETURN jsonb_build_object('error', 'refund_exists'); END IF;
  SELECT status, total, currency INTO v_order_status, v_order_total, v_currency FROM commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  SELECT id, status, provider, provider_payment_id INTO v_intent_id, v_intent_status, v_provider, v_provider_payment_id FROM payment_intents WHERE order_id = p_order_id FOR UPDATE;
  IF v_order_status <> 'paid' OR v_intent_status IS DISTINCT FROM 'succeeded' OR v_provider_payment_id IS NULL THEN RETURN jsonb_build_object('error', 'invalid_state'); END IF;
  INSERT INTO refunds(id, order_id, payment_intent_id, requested_by, idempotency_key, provider, amount, currency, reason)
  VALUES (p_refund_id, p_order_id, v_intent_id, p_actor_id, p_idempotency_key, v_provider, v_order_total, v_currency, trim(p_reason));
  INSERT INTO refund_audits(id, refund_id, actor_id, event_type, from_status, to_status, metadata)
  VALUES (gen_random_uuid()::text, p_refund_id, p_actor_id, 'refund.requested', NULL, 'processing', jsonb_build_object('amount', v_order_total, 'currency', v_currency, 'provider', v_provider, 'providerPaymentId', v_provider_payment_id, 'reason', trim(p_reason))::text);
  RETURN jsonb_build_object('refundId', p_refund_id, 'paymentIntentId', v_intent_id, 'providerPaymentId', v_provider_payment_id, 'provider', v_provider,
    'amount', v_order_total, 'currency', v_currency, 'reason', trim(p_reason), 'status', 'processing', 'created', true, 'replayed', false);
END $$;
