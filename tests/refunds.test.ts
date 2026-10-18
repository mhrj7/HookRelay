import assert from "node:assert/strict";
import test from "node:test";
import { refundInput } from "../lib/refund-service";
import { InternalTestPaymentProvider } from "../lib/payment-provider";

test("M-30 refund input requires an idempotency key and bounded reason", () => {
  assert.deepEqual(refundInput({ key: "refund-key-00001", reason: "Customer returned item" }), { key: "refund-key-00001", reason: "Customer returned item" });
  for (const value of [null, {}, { key: "short", reason: "Valid reason" }, { key: "refund-key-00001", reason: "no" }, { key: "refund-key-00001", reason: "x".repeat(241) }, { key: "refund-key-00001", reason: "Valid reason", amount: 1 }]) assert.equal(refundInput(value), null);
});

test("M-30 internal payment provider refund is deterministic for the same idempotency key", async () => {
  const provider = new InternalTestPaymentProvider();
  const request = { providerPaymentId: "pay-1", amount: 450, currency: "INR", idempotencyKey: "refund-key-00001", reason: "Customer returned item" };
  assert.deepEqual(await provider.refund(request), await provider.refund(request));
});
