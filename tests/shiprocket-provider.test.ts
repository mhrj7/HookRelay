import assert from "node:assert/strict";
import test from "node:test";
import { ShiprocketShippingProvider, type ShipmentCreateRequest } from "../lib/shipping-provider";

type Call = { url: string; init: RequestInit };

const request: ShipmentCreateRequest = {
  orderId: "order_m36_001",
  recipient: { name: "Buyer", email: "buyer@example.test", phone: "9999999999", address: "1 Test Street", city: "Bengaluru", state: "Karnataka", pincode: "560001" },
  pickup: { location: "m36-test-pickup", name: "Seller", email: "seller@example.test", phone: "9888888888", address: "2 Seller Street", city: "Bengaluru", state: "Karnataka", pincode: "560001" },
  item: { name: "M-36 test item", unitPrice: 125 },
  createdAt: "2026-10-16T10:00:00.000Z",
};

function scenario(environment: "sandbox" | "production") {
  const calls: Call[] = [];
  const fetcher = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input); calls.push({ url, init });
    if (url.endsWith("/auth/login")) return Response.json({ token: `${environment}-token` });
    if (url.endsWith("/orders/create/adhoc")) return Response.json({ shipment_id: environment === "sandbox" ? 101 : 202 });
    if (url.endsWith("/courier/assign/awb")) return Response.json({ awb_code: environment === "sandbox" ? "SBX-AWB-001" : "PROD-AWB-001", courier_name: "Test Express" });
    if (url.includes("/courier/track/awb/")) return Response.json({ current_status: "In Transit" });
    throw new Error(`Unexpected request: ${url}`);
  };
  return { calls, provider: new ShiprocketShippingProvider(environment, `${environment}@example.test`, `${environment}-secret`, fetcher) };
}

test("M-36 Shiprocket sandbox and production request paths are independently isolated", async () => {
  const sandbox = scenario("sandbox");
  const production = scenario("production");
  const sandboxResult = await sandbox.provider.createShipment(request);
  const productionResult = await production.provider.createShipment(request);

  assert.equal(sandboxResult.trackingNumber, "SBX-AWB-001");
  assert.equal(productionResult.trackingNumber, "PROD-AWB-001");
  assert.ok(sandbox.calls.every(({ url }) => url.startsWith("https://api-sandbox.shiprocket.in/v1/external/")));
  assert.ok(production.calls.every(({ url }) => url.startsWith("https://apiv2.shiprocket.in/v1/external/")));
  assert.equal(JSON.parse(String(sandbox.calls[0].init.body)).email, "sandbox@example.test");
  assert.equal(JSON.parse(String(production.calls[0].init.body)).email, "production@example.test");
  const orderPayload = JSON.parse(String(production.calls[1].init.body));
  assert.equal(orderPayload.pickup_location, "m36-test-pickup");
  assert.equal(orderPayload.billing_pincode, "560001");
  assert.equal(orderPayload.order_items[0].selling_price, 125);
  assert.equal(JSON.parse(String(production.calls[2].init.body)).shipment_id, 202);
});

test("M-36 Shiprocket tracking translates a real-provider status without crossing environments", async () => {
  const production = scenario("production");
  const update = await production.provider.advanceShipment({ trackingNumber: "PROD-AWB-001", currentStatus: "picked_up", occurredAt: "2026-10-16T11:00:00.000Z" });
  assert.deepEqual(update, { status: "in_transit", message: "Shiprocket tracking update: In Transit." });
  assert.ok(production.calls.every(({ url }) => url.startsWith("https://apiv2.shiprocket.in/v1/external/")));
});

test("M-36 Shiprocket provider does not expose credentials in upstream errors", async () => {
  const provider = new ShiprocketShippingProvider("production", "production@example.test", "never-expose-this", async () => Response.json({ message: "Unauthorized" }, { status: 401 }));
  await assert.rejects(provider.createShipment(request), (error: unknown) => error instanceof Error && error.message === "Unauthorized (HTTP 401)");
});
