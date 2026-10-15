import assert from "node:assert/strict";
import test from "node:test";
import { cartItemInput } from "../lib/cart-service";

test("M-25 cart input accepts only a SKU and whole-number quantity from 1 to 20", () => {
  assert.deepEqual(cartItemInput({ variantId: "sku-1", quantity: 1 }), { variantId: "sku-1", quantity: 1 });
  assert.deepEqual(cartItemInput({ variantId: "sku_2", quantity: 20 }), { variantId: "sku_2", quantity: 20 });
  for (const value of [null, {}, { variantId: "sku", quantity: 0 }, { variantId: "sku", quantity: 21 }, { variantId: "sku", quantity: 1.5 }, { variantId: "sku", quantity: 1, price: 1 }]) {
    assert.equal(cartItemInput(value), null);
  }
});
