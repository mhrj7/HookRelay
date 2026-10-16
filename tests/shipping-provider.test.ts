import assert from "node:assert/strict";
import test from "node:test";
import { advanceShipmentRecord, createShipmentRecord } from "../lib/shipment-service";
import type { ShippingProvider } from "../lib/shipping-provider";

test("M-33 order shipment domain uses an injected mock provider without provider-specific logic", async () => {
  const calls: string[] = [];
  const mockProvider: ShippingProvider = {
    name: "mock-carrier",
    async createShipment(request) {
      calls.push(`create:${request.orderId}:${request.recipient.pincode}`);
      return {
        provider: "Mock carrier",
        trackingNumber: "MOCK-TRACK-001",
        status: "label_created",
        eta: "2026-10-19T10:00:00.000Z",
        message: "Mock label created.",
        providerShipmentId: "mock-shipment-001",
        awbCode: "MOCKAWB001",
        courierName: "Mock Express",
      };
    },
    async advanceShipment(request) {
      calls.push(`advance:${request.trackingNumber}:${request.currentStatus}`);
      return request.currentStatus === "label_created"
        ? { status: "picked_up", message: "Mock carrier picked up the parcel." }
        : null;
    },
  };

  const created = await createShipmentRecord("order_001", {
    orderId: "order_001",
    recipient: { name: "Buyer", email: "buyer@example.test", phone: "9999999999", address: "1 Test Street", city: "Bengaluru", state: "Karnataka", pincode: "560001" },
    pickup: { location: "test-pickup", name: "Seller", email: "seller@example.test", phone: "9888888888", address: "2 Seller Street", city: "Bengaluru", state: "Karnataka", pincode: "560001" },
    item: { name: "Test item", unitPrice: 125 },
    createdAt: "2026-10-16T10:00:00.000Z",
  }, mockProvider);
  assert.equal(created.shipment.provider, "Mock carrier");
  assert.equal(created.shipment.trackingNumber, "MOCK-TRACK-001");
  assert.equal(created.shipment.shiprocketShipmentId, "mock-shipment-001");
  assert.deepEqual(created.event, { status: "label_created", message: "Mock label created.", occurredAt: "2026-10-16T10:00:00.000Z" });

  const advanced = await advanceShipmentRecord(created.shipment, "2026-10-16T11:00:00.000Z", mockProvider);
  assert.equal(advanced?.shipment.status, "picked_up");
  assert.equal(advanced?.event.message, "Mock carrier picked up the parcel.");
  assert.deepEqual(calls, ["create:order_001:560001", "advance:MOCK-TRACK-001:label_created"]);
  assert.equal(await advanceShipmentRecord({ ...created.shipment, status: "delivered" }, "2026-10-16T12:00:00.000Z", mockProvider), null);
});
