import assert from "node:assert/strict";
import test from "node:test";
import { checkoutInput } from "../lib/checkout-service";

test("M-27 checkout input requires one bounded idempotency key and a unique reservation list", () => {
  assert.deepEqual(checkoutInput({ key: "checkout-key-0001", reservationIds: ["r-1", "r-2"] }), { key: "checkout-key-0001", reservationIds: ["r-1", "r-2"] });
  for (const value of [null, {}, { key: "short", reservationIds: ["r-1"] }, { key: "checkout-key-0001", reservationIds: [] }, { key: "checkout-key-0001", reservationIds: ["r-1", "r-1"] }, { key: "checkout-key-0001", reservationIds: ["bad id"] }, { key: "checkout-key-0001", reservationIds: ["r-1"], total: 1 }]) assert.equal(checkoutInput(value), null);
});
