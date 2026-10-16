import assert from "node:assert/strict";
import test from "node:test";
import { parseDisputeCreate, parseDisputeDecision } from "../lib/dispute-service";

test("M-41 dispute inputs require an order reference and bounded reason", () => {
  assert.deepEqual(parseDisputeCreate({ orderId: "order-1", reason: "Buyer reported the wrong item." }), { orderId: "order-1", reason: "Buyer reported the wrong item." });
  assert.equal(parseDisputeCreate({ orderId: "", reason: "Valid enough" }), null);
  assert.equal(parseDisputeCreate({ orderId: "order-1", reason: "no" }), null);
});

test("M-41 dispute lifecycle requires a final resolution and never reopens final disputes", () => {
  assert.deepEqual(parseDisputeDecision({ status: "under_review" }, "open"), { status: "under_review", resolution: null });
  assert.deepEqual(parseDisputeDecision({ status: "resolved", resolution: "Seller confirmed a full refund." }, "under_review"), { status: "resolved", resolution: "Seller confirmed a full refund." });
  assert.equal(parseDisputeDecision({ status: "resolved", resolution: "no" }, "open"), null);
  assert.equal(parseDisputeDecision({ status: "under_review" }, "resolved"), null);
});
