import assert from "node:assert/strict";
import test from "node:test";
import {
  createInternalTestSignature,
  InternalTestPaymentProvider,
  type PaymentProvider,
  RazorpayTestPaymentProvider,
} from "../lib/payment-provider";
import { createRazorpaySignature } from "../lib/razorpay-signature";

async function assertSharedContract(
  provider: PaymentProvider,
  signatureFor: (providerOrderId: string, providerPaymentId: string) => Promise<string>,
) {
  const checkout = await provider.createCheckout({
    intentId: "intent_123",
    amount: 125,
    currency: "INR",
    receipt: "receipt_123",
    metadata: { marketplace_order_id: "marketplace_123", environment: "test" },
  });
  assert.ok(checkout.providerOrderId);
  assert.equal(checkout.currency, "INR");
  assert.ok(checkout.amount > 0);

  const providerPaymentId = "pay_test_456";
  const verified = await provider.verifyPayment({
    providerOrderId: checkout.providerOrderId,
    providerPaymentId,
    signature: await signatureFor(checkout.providerOrderId, providerPaymentId),
  });
  assert.equal(verified.verified, true);
  const rejected = await provider.verifyPayment({
    providerOrderId: checkout.providerOrderId,
    providerPaymentId,
    signature: "bad-signature",
  });
  assert.equal(rejected.verified, false);

  const refund = await provider.refund({
    providerPaymentId,
    amount: 125,
    currency: "INR",
    idempotencyKey: "refund-key-00001",
    reason: "Customer returned item",
  });
  assert.equal(refund.status, "succeeded");
  assert.ok(refund.providerRefundId);
}

test("M-31 internal test adapter satisfies the shared payment provider contract", async () => {
  await assertSharedContract(
    new InternalTestPaymentProvider(),
    async (providerOrderId, providerPaymentId) => createInternalTestSignature(providerOrderId, providerPaymentId),
  );

});

test("M-31 Razorpay test adapter satisfies the same contract and sends paise to Razorpay", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
  const provider = new RazorpayTestPaymentProvider({
    keyId: "rzp_test_contract",
    keySecret: "contract-secret",
    fetcher: async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, body, authorization: headers.get("Authorization") });
      if (url.endsWith("/orders")) return Response.json({ id: "order_test_contract", amount: 12500, currency: "INR" });
      if (url.endsWith("/payments/pay_test_456")) return Response.json({ id: "pay_test_456", order_id: "order_test_contract", status: "captured", amount: 12500, currency: "INR" });
      if (url.endsWith("/payments/pay_test_456/refund")) return Response.json({ id: "rfnd_test_contract", status: "processed" });
      return Response.json({ error: { description: "Unexpected test request" } }, { status: 400 });
    },
  });

  await assertSharedContract(
    provider,
    (providerOrderId, providerPaymentId) => createRazorpaySignature(providerOrderId, providerPaymentId, "contract-secret"),
  );

  const captured = await provider.verifyCapturedPayment({ providerOrderId: "order_test_contract", providerPaymentId: "pay_test_456",
    signature: await createRazorpaySignature("order_test_contract", "pay_test_456", "contract-secret"), amount: 125, currency: "INR" });
  assert.equal(captured.verified, true);

  assert.deepEqual(calls.map(call => call.url), [
    "https://api.razorpay.com/v1/orders",
    "https://api.razorpay.com/v1/payments/pay_test_456/refund",
    "https://api.razorpay.com/v1/payments/pay_test_456",
  ]);
  assert.equal(calls[0].body.amount, 12500);
  assert.equal(calls[0].body.currency, "INR");
  assert.deepEqual(calls[1].body, {
    amount: 12500,
    notes: { reason: "Customer returned item", idempotency_key: "refund-key-00001" },
  });
  assert.equal(calls[0].authorization, `Basic ${Buffer.from("rzp_test_contract:contract-secret").toString("base64")}`);
});

test("Razorpay rejects valid signatures when the payment is uncaptured or mismatched", async () => {
  for (const change of [{ status: "authorized" }, { amount: 12400 }, { currency: "USD" }, { order_id: "order_other" }, { id: "pay_other" }]) {
    const provider = new RazorpayTestPaymentProvider({ keyId: "rzp_test_contract", keySecret: "contract-secret", fetcher: async () =>
      Response.json({ id: "pay_test_456", order_id: "order_test_contract", status: "captured", amount: 12500, currency: "INR", ...change }) });
    const result = await provider.verifyCapturedPayment({ providerOrderId: "order_test_contract", providerPaymentId: "pay_test_456",
      signature: await createRazorpaySignature("order_test_contract", "pay_test_456", "contract-secret"), amount: 125, currency: "INR" });
    assert.equal(result.verified, false);
  }
});

test("M-31 Razorpay adapter surfaces a sanitized provider error", async () => {
  const provider = new RazorpayTestPaymentProvider({
    keyId: "rzp_test_contract",
    keySecret: "contract-secret",
    fetcher: async () => Response.json({ error: { description: "Refund cannot be processed" } }, { status: 400 }),
  });
  await assert.rejects(
    provider.refund({ providerPaymentId: "pay_test_456", amount: 125, currency: "INR", idempotencyKey: "refund-key-00001", reason: "Customer returned item" }),
    /Refund cannot be processed \(HTTP 400\)/,
  );
});
