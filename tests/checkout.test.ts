import assert from "node:assert/strict";
import test from "node:test";
import { checkoutInput } from "../lib/checkout-service";

test("M-26 checkout input accepts exactly one unique reservation list", () => {
  assert.deepEqual(checkoutInput({ reservationIds: ["r-1", "r-2"] }), { reservationIds: ["r-1", "r-2"] });
  for (const value of [null, {}, { reservationIds: [] }, { reservationIds: ["r-1", "r-1"] }, { reservationIds: ["bad id"] }, { reservationIds: ["r-1"], total: 1 }]) assert.equal(checkoutInput(value), null);
});
