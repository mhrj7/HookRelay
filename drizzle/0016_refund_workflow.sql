CREATE TABLE IF NOT EXISTS refunds (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  payment_intent_id text NOT NULL REFERENCES payment_intents(id) ON DELETE RESTRICT,
  requested_by integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  provider text NOT NULL,
  provider_refund_id text,
  amount integer NOT NULL CHECK (amount > 0),
  currency text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  provider_response text,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT refunds_status_check CHECK (status IN ('processing', 'succeeded', 'failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS refunds_order_id_key ON refunds(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS refunds_requested_by_idempotency_key_key ON refunds(requested_by, idempotency_key);

CREATE TABLE IF NOT EXISTS refund_audits (
  id text PRIMARY KEY,
  refund_id text NOT NULL REFERENCES refunds(id) ON DELETE RESTRICT,
  actor_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  metadata text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_refund_audits_refund_created ON refund_audits(refund_id, created_at);

CREATE OR REPLACE FUNCTION begin_order_refund(
  p_refund_id text,
  p_order_id text,
  p_actor_id integer,
  p_idempotency_key text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_order_status text;
  v_order_total integer;
  v_currency text;
  v_intent_id text;
  v_intent_status text;
  v_provider text;
  v_outbox_id text;
  v_existing refunds%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 16 OR length(p_idempotency_key) > 80 OR
     p_reason IS NULL OR length(trim(p_reason)) < 5 OR length(trim(p_reason)) > 240 THEN
    RETURN jsonb_build_object('error', 'invalid');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('refund:' || p_order_id, 0));

  SELECT * INTO v_existing FROM refunds WHERE requested_by = p_actor_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.order_id <> p_order_id THEN RETURN jsonb_build_object('error', 'key_conflict'); END IF;
    IF v_existing.status = 'failed' THEN
      UPDATE refunds SET status = 'processing', failure_reason = NULL WHERE id = v_existing.id;
      INSERT INTO refund_audits(id, refund_id, actor_id, event_type, from_status, to_status, metadata)
      VALUES (gen_random_uuid()::text, v_existing.id, p_actor_id, 'refund.retried', 'failed', 'processing', jsonb_build_object('reason', v_existing.reason)::text);
      v_existing.status := 'processing';
    END IF;
    IF v_existing.status = 'succeeded' THEN
      SELECT id INTO v_outbox_id FROM outbox_events
      WHERE aggregate_type = 'order' AND aggregate_id = v_existing.order_id AND event_type = 'order.refunded';
      RETURN jsonb_build_object(
        'refundId', v_existing.id, 'paymentIntentId', v_existing.payment_intent_id, 'provider', v_existing.provider,
        'providerRefundId', v_existing.provider_refund_id, 'amount', v_existing.amount, 'currency', v_existing.currency,
        'reason', v_existing.reason, 'status', v_existing.status, 'completedAt', v_existing.completed_at,
        'outboxEventId', v_outbox_id, 'replayed', true
      );
    END IF;
    RETURN jsonb_build_object(
      'refundId', v_existing.id, 'paymentIntentId', v_existing.payment_intent_id, 'provider', v_existing.provider,
      'amount', v_existing.amount, 'currency', v_existing.currency, 'reason', v_existing.reason,
      'status', v_existing.status, 'created', false, 'replayed', false
    );
  END IF;

  IF EXISTS (SELECT 1 FROM refunds WHERE order_id = p_order_id) THEN RETURN jsonb_build_object('error', 'refund_exists'); END IF;

  SELECT status, total, currency INTO v_order_status, v_order_total, v_currency
  FROM commerce_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;

  SELECT id, status, provider INTO v_intent_id, v_intent_status, v_provider
  FROM payment_intents WHERE order_id = p_order_id FOR UPDATE;
  IF v_order_status <> 'paid' OR v_intent_status IS DISTINCT FROM 'succeeded' THEN
    RETURN jsonb_build_object('error', 'invalid_state');
  END IF;

  INSERT INTO refunds(id, order_id, payment_intent_id, requested_by, idempotency_key, provider, amount, currency, reason)
  VALUES (p_refund_id, p_order_id, v_intent_id, p_actor_id, p_idempotency_key, v_provider, v_order_total, v_currency, trim(p_reason));
  INSERT INTO refund_audits(id, refund_id, actor_id, event_type, from_status, to_status, metadata)
  VALUES (gen_random_uuid()::text, p_refund_id, p_actor_id, 'refund.requested', NULL, 'processing', jsonb_build_object('amount', v_order_total, 'currency', v_currency, 'provider', v_provider, 'reason', trim(p_reason))::text);

  RETURN jsonb_build_object(
    'refundId', p_refund_id, 'paymentIntentId', v_intent_id, 'provider', v_provider,
    'amount', v_order_total, 'currency', v_currency, 'reason', trim(p_reason),
    'status', 'processing', 'created', true, 'replayed', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION complete_order_refund(
  p_refund_id text,
  p_actor_id integer,
  p_provider_refund_id text,
  p_provider_response text,
  p_audit_id text,
  p_outbox_id text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_refund refunds%ROWTYPE;
  v_completed_at timestamptz;
  v_outbox_id text;
BEGIN
  SELECT * INTO v_refund FROM refunds WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_refund.status = 'succeeded' THEN
    SELECT id INTO v_outbox_id FROM outbox_events WHERE aggregate_type = 'order' AND aggregate_id = v_refund.order_id AND event_type = 'order.refunded';
    RETURN jsonb_build_object(
      'refundId', v_refund.id, 'paymentIntentId', v_refund.payment_intent_id, 'provider', v_refund.provider,
      'providerRefundId', v_refund.provider_refund_id, 'amount', v_refund.amount, 'currency', v_refund.currency,
      'reason', v_refund.reason, 'status', v_refund.status, 'completedAt', v_refund.completed_at,
      'outboxEventId', v_outbox_id, 'replayed', true
    );
  END IF;
  IF v_refund.status <> 'processing' THEN RETURN jsonb_build_object('error', 'invalid_state'); END IF;

  PERFORM 1 FROM commerce_orders WHERE id = v_refund.order_id AND status = 'paid' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'invalid_state'); END IF;
  PERFORM 1 FROM payment_intents WHERE id = v_refund.payment_intent_id AND status = 'succeeded' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'invalid_state'); END IF;

  UPDATE refunds SET status = 'succeeded', provider_refund_id = p_provider_refund_id,
    provider_response = p_provider_response, completed_at = clock_timestamp()
  WHERE id = p_refund_id RETURNING completed_at INTO v_completed_at;
  UPDATE payment_intents SET status = 'refunded' WHERE id = v_refund.payment_intent_id;
  UPDATE commerce_orders SET status = 'refunded', updated_at = clock_timestamp() WHERE id = v_refund.order_id;
  INSERT INTO refund_audits(id, refund_id, actor_id, event_type, from_status, to_status, metadata)
  VALUES (p_audit_id, p_refund_id, p_actor_id, 'refund.succeeded', 'processing', 'succeeded', jsonb_build_object('providerRefundId', p_provider_refund_id)::text);
  INSERT INTO outbox_events(id, aggregate_type, aggregate_id, event_type, payload)
  VALUES (p_outbox_id, 'order', v_refund.order_id, 'order.refunded', jsonb_build_object('orderId', v_refund.order_id, 'refundId', p_refund_id, 'amount', v_refund.amount, 'currency', v_refund.currency)::text)
  RETURNING id INTO v_outbox_id;

  RETURN jsonb_build_object(
    'refundId', p_refund_id, 'paymentIntentId', v_refund.payment_intent_id, 'provider', v_refund.provider,
    'providerRefundId', p_provider_refund_id, 'amount', v_refund.amount, 'currency', v_refund.currency,
    'reason', v_refund.reason, 'status', 'succeeded', 'completedAt', v_completed_at,
    'outboxEventId', v_outbox_id, 'replayed', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION fail_order_refund(
  p_refund_id text,
  p_actor_id integer,
  p_failure_reason text,
  p_audit_id text
) RETURNS void
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
  UPDATE refunds SET status = 'failed', failure_reason = p_failure_reason WHERE id = p_refund_id AND status = 'processing';
  IF FOUND THEN
    INSERT INTO refund_audits(id, refund_id, actor_id, event_type, from_status, to_status, metadata)
    VALUES (p_audit_id, p_refund_id, p_actor_id, 'refund.failed', 'processing', 'failed', jsonb_build_object('failure', p_failure_reason)::text);
  END IF;
END;
$$;
