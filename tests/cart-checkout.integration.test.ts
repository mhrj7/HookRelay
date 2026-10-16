import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { getDb } from "../db";
import { cartItems, carts, categories, commerceOrderItems, commerceOrders, inventoryReservations, outboxEvents, paymentIntents, products, productVariants, refundAudits, refunds, stores, users, warehouses, warehouseStock } from "../db/schema";
import { issueAccessToken } from "../lib/api-tokens";
import { POST as cartPost } from "../app/api/cart/route";
import { POST as reservationPost } from "../app/api/checkout/reservations/route";
import { POST as checkoutPost } from "../app/api/checkout/orders/route";
import { POST as cancellationPost } from "../app/api/checkout/orders/[id]/cancel/route";
import { GET as availabilityGet } from "../app/api/checkout/availability/route";
import { POST as refundPost } from "../app/api/checkout/orders/[id]/refunds/route";

type HttpData = {
  error?: string;
  reservation?: { id: string };
  order?: { orderId: string; paymentIntentId: string; outboxEventId: string; status: string; total: number; currency: string; replayed?: boolean };
  cancellation?: { orderId: string; status: string; cancelledAt: string; outboxEventId: string; releasedQuantity: number; replayed: boolean };
  refund?: { refundId: string; paymentIntentId: string; provider: string; providerRefundId: string; amount: number; currency: string; reason: string; status: string; completedAt: string; outboxEventId: string; replayed: boolean };
  item?: { available: number };
};

test("M-26/M-27/M-29/M-30 HTTP: checkout, cancellation, and authorized refund workflows persist exact effects", {
  skip: process.env.RUN_CART_CHECKOUT_INTEGRATION !== "1", timeout: 30000,
}, async () => {
  assert.match(process.env.DATABASE_URL ?? "", /@(db|localhost|127\.0\.0\.1)(:|\/)/);
  const previousSecret = process.env.JWT_AUTH_SECRET;
  process.env.JWT_AUTH_SECRET = crypto.randomUUID() + crypto.randomUUID();
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const body = Buffer.concat(chunks).toString();
      const request = new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method, headers, ...(incoming.method === "GET" || incoming.method === "HEAD" ? {} : { body }) });
      const path = new URL(request.url).pathname;
      const cancelMatch = path.match(/^\/api\/checkout\/orders\/([^/]+)\/cancel$/);
      const refundMatch = path.match(/^\/api\/checkout\/orders\/([^/]+)\/refunds$/);
      const response = path === "/api/cart" ? await cartPost(request)
        : path === "/api/checkout/reservations" ? await reservationPost(request)
          : path === "/api/checkout/orders" ? await checkoutPost(request)
            : path === "/api/checkout/availability" ? await availabilityGet(request)
              : cancelMatch ? await cancellationPost(request, { params: Promise.resolve({ id: cancelMatch[1] }) })
                : refundMatch ? await refundPost(request, { params: Promise.resolve({ id: refundMatch[1] }) })
                : new Response(null, { status: 404 });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
    } catch (error) { console.error(error); outgoing.writeHead(500); outgoing.end("Test handler failed"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const db = getDb(); const tag = crypto.randomUUID(); const userIds: number[] = [];
  const storeId = crypto.randomUUID(), productId = crypto.randomUUID(), warehouseId = crypto.randomUUID();
  const variantIds = [crypto.randomUUID(), crypto.randomUUID()];
  async function post(token: string, path: string, body: unknown) {
    const response = await fetch(`${origin}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() as HttpData };
  }
  async function availability(variantId: string) {
    const response = await fetch(`${origin}/api/checkout/availability?variant=${variantId}`);
    return { status: response.status, data: await response.json() as HttpData };
  }
  try {
    for (const file of ["0010_inventory_reservations.sql", "0011_reservation_release.sql", "0012_buyer_cart.sql", "0013_cart_checkout.sql", "0014_checkout_idempotency.sql", "0015_order_cancellation.sql", "0016_refund_workflow.sql"]) {
      await db.execute(sql.raw(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8")));
    }
    const clerkIds = ["seller", "buyer-a", "buyer-b", "admin"].map(role => `m26-${role}-${tag}`);
    for (let i = 0; i < clerkIds.length; i++) {
      const role = i === 0 ? "seller" : i === 3 ? "admin" : "buyer";
      const [user] = await db.insert(users).values({ clerkId: clerkIds[i], role, sellerApprovalStatus: i === 0 ? "approved" : "not_requested" }).returning(); userIds.push(user.id);
    }
    await db.insert(stores).values({ id: storeId, ownerId: userIds[0], name: "M26 local fixture", slug: tag, city: "Test", description: "Local only" });
    await db.insert(categories).values({ id: tag, name: "Test", slug: tag });
    await db.insert(products).values({ id: productId, storeId, categoryId: tag, title: "Atomic checkout fixture", description: "Local only", price: 100 });
    await db.insert(productVariants).values([
      { id: variantIds[0], productId, name: "First", sku: `M26-A-${tag}`, price: 125 },
      { id: variantIds[1], productId, name: "Second", sku: `M26-B-${tag}`, price: 200 },
    ]);
    await db.insert(warehouses).values({ id: warehouseId, storeId, name: "M26 warehouse", city: "Test", address: "Local", postcode: "560001" });
    await db.insert(warehouseStock).values(variantIds.map(variantId => ({ warehouseId, variantId, quantity: 10 })));
    const [sellerToken, buyerAToken, buyerBToken, adminToken] = await Promise.all(clerkIds.map(clerkId => issueAccessToken({ clerkId })));
    void sellerToken;

    assert.equal((await post(buyerAToken, "/api/cart", { variantId: variantIds[0], quantity: 2 })).status, 200);
    assert.equal((await post(buyerAToken, "/api/cart", { variantId: variantIds[1], quantity: 1 })).status, 200);
    const reservationIds: string[] = [];
    for (const [index, quantity] of [2, 1].entries()) {
      const held = await post(buyerAToken, "/api/checkout/reservations", { variantId: variantIds[index], quantity, key: crypto.randomUUID() });
      assert.equal(held.status, 200); assert.ok(held.data.reservation); reservationIds.push(held.data.reservation.id);
    }

    assert.equal((await post(buyerBToken, "/api/cart", { variantId: variantIds[0], quantity: 2 })).status, 200);
    const invalid = await post(buyerBToken, "/api/checkout/orders", { key: crypto.randomUUID(), reservationIds: [reservationIds[0]] });
    assert.equal(invalid.status, 409);
    assert.equal((await db.select().from(commerceOrders)).length, 0); assert.equal((await db.select().from(paymentIntents)).length, 0); assert.equal((await db.select().from(outboxEvents)).length, 0);
    assert.equal((await db.select().from(cartItems).innerJoin(carts, eq(cartItems.cartId, carts.id)).where(eq(carts.buyerId, userIds[2]))).length, 1, "Failed checkout leaves cart intact");

    const checkoutKey = crypto.randomUUID();
    const duplicatePair = await Promise.all([
      post(buyerAToken, "/api/checkout/orders", { key: checkoutKey, reservationIds }),
      post(buyerAToken, "/api/checkout/orders", { key: checkoutKey, reservationIds }),
    ]);
    assert.deepEqual(duplicatePair.map(result => result.status).sort(), [200, 201]);
    const checkout = duplicatePair.find(result => result.status === 201)!;
    const replay = duplicatePair.find(result => result.status === 200)!;
    assert.equal(checkout.status, 201); assert.ok(checkout.data.order); assert.equal(checkout.data.order.status, "pending_payment"); assert.equal(checkout.data.order.total, 450); assert.equal(checkout.data.order.currency, "INR");
    assert.deepEqual(replay.data.order, { ...checkout.data.order, replayed: true });
    const [order] = await db.select().from(commerceOrders).where(eq(commerceOrders.id, checkout.data.order.orderId));
    const items = await db.select().from(commerceOrderItems).where(eq(commerceOrderItems.orderId, order.id));
    const [intent] = await db.select().from(paymentIntents).where(eq(paymentIntents.orderId, order.id));
    const [event] = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, order.id));
    assert.equal(order.buyerId, userIds[1]); assert.equal(order.total, 450); assert.equal(items.length, 2); assert.equal(items.reduce((sum, item) => sum + item.lineTotal, 0), 450);
    assert.equal(intent.id, checkout.data.order.paymentIntentId); assert.equal(intent.amount, 450); assert.equal(intent.status, "requires_payment_method");
    assert.equal(event.id, checkout.data.order.outboxEventId); assert.equal(event.eventType, "order.created"); assert.equal(event.status, "pending"); assert.deepEqual(JSON.parse(event.payload), { total: 450, buyerId: userIds[1], orderId: order.id, currency: "INR", itemCount: 2 });
    assert.equal((await db.select().from(cartItems).innerJoin(carts, eq(cartItems.cartId, carts.id)).where(eq(carts.buyerId, userIds[1]))).length, 0, "Successful checkout clears only the buyer's items");

    const changedPayload = await post(buyerAToken, "/api/checkout/orders", { key: checkoutKey, reservationIds: [reservationIds[0]] });
    assert.equal(changedPayload.status, 409); assert.match(changedPayload.data.error ?? "", /idempotency key/i);
    assert.equal((await db.select().from(commerceOrders)).length, 1); assert.equal((await db.select().from(paymentIntents)).length, 1); assert.equal((await db.select().from(outboxEvents)).length, 1);

    assert.equal((await post(buyerAToken, "/api/cart", { variantId: variantIds[0], quantity: 2 })).status, 200);
    const reused = await post(buyerAToken, "/api/checkout/orders", { key: crypto.randomUUID(), reservationIds: [reservationIds[0]] });
    assert.equal(reused.status, 409); assert.equal((await db.select().from(commerceOrders)).length, 1); assert.equal((await db.select().from(paymentIntents)).length, 1); assert.equal((await db.select().from(outboxEvents)).length, 1);

    assert.equal((await availability(variantIds[0])).data.item?.available, 8);
    assert.equal((await availability(variantIds[1])).data.item?.available, 9);
    const cancelPath = `/api/checkout/orders/${order.id}/cancel`;
    const deniedCancellation = await post(buyerBToken, cancelPath, {});
    assert.equal(deniedCancellation.status, 404, "Another buyer cannot discover or cancel the order");
    await db.update(commerceOrders).set({ status: "processing" }).where(eq(commerceOrders.id, order.id));
    const invalidCancellation = await post(buyerAToken, cancelPath, {});
    assert.equal(invalidCancellation.status, 409, "A non-cancellable state cannot transition to cancelled");
    await db.update(commerceOrders).set({ status: "pending_payment" }).where(eq(commerceOrders.id, order.id));

    const cancellation = await post(buyerAToken, cancelPath, {});
    assert.equal(cancellation.status, 200); assert.ok(cancellation.data.cancellation);
    assert.equal(cancellation.data.cancellation.status, "cancelled"); assert.equal(cancellation.data.cancellation.releasedQuantity, 3);
    assert.equal((await availability(variantIds[0])).data.item?.available, 10);
    assert.equal((await availability(variantIds[1])).data.item?.available, 10);
    const [cancelledOrder] = await db.select().from(commerceOrders).where(eq(commerceOrders.id, order.id));
    const [cancelledIntent] = await db.select().from(paymentIntents).where(eq(paymentIntents.orderId, order.id));
    const released = await db.select().from(inventoryReservations).where(inArray(inventoryReservations.id, reservationIds));
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, order.id));
    assert.equal(cancelledOrder.status, "cancelled"); assert.ok(cancelledOrder.cancelledAt); assert.equal(cancelledIntent.status, "cancelled");
    assert.ok(released.every(row => row.releaseReason === "order_cancelled" && row.releasedAt));
    assert.deepEqual(events.map(row => row.eventType).sort(), ["order.cancelled", "order.created"]);
    const cancellationReplay = await post(buyerAToken, cancelPath, {});
    assert.equal(cancellationReplay.status, 200);
    assert.deepEqual(cancellationReplay.data.cancellation, { ...cancellation.data.cancellation, replayed: true });
    assert.equal((await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, order.id))).length, 2, "Retry creates no duplicate cancellation event");

    assert.equal((await post(buyerAToken, "/api/cart", { variantId: variantIds[0], quantity: 1 })).status, 200);
    const refundReservation = await post(buyerAToken, "/api/checkout/reservations", { variantId: variantIds[0], quantity: 1, key: crypto.randomUUID() });
    assert.equal(refundReservation.status, 200); assert.ok(refundReservation.data.reservation);
    const refundableCheckout = await post(buyerAToken, "/api/checkout/orders", { key: crypto.randomUUID(), reservationIds: [refundReservation.data.reservation.id] });
    assert.equal(refundableCheckout.status, 201); assert.ok(refundableCheckout.data.order);
    const refundPath = `/api/checkout/orders/${refundableCheckout.data.order.orderId}/refunds`;
    const invalidStateRefund = await post(adminToken, refundPath, { key: crypto.randomUUID(), reason: "Requested before payment" });
    assert.equal(invalidStateRefund.status, 409); assert.match(invalidStateRefund.data.error ?? "", /paid/i);
    await db.update(commerceOrders).set({ status: "paid" }).where(eq(commerceOrders.id, refundableCheckout.data.order.orderId));
    await db.update(paymentIntents).set({ status: "succeeded" }).where(eq(paymentIntents.id, refundableCheckout.data.order.paymentIntentId));
    const refundKey = crypto.randomUUID();
    const deniedRefund = await post(buyerAToken, refundPath, { key: refundKey, reason: "Customer returned item" });
    assert.equal(deniedRefund.status, 403, "A buyer cannot issue their own refund");
    const refund = await post(adminToken, refundPath, { key: refundKey, reason: "Customer returned item" });
    assert.equal(refund.status, 201); assert.ok(refund.data.refund); assert.equal(refund.data.refund.status, "succeeded");
    assert.equal(refund.data.refund.amount, 125); assert.equal(refund.data.refund.currency, "INR"); assert.equal(refund.data.refund.provider, "internal_test");
    assert.match(refund.data.refund.providerRefundId, /^rf_test_[a-f0-9]{24}$/);
    const [storedRefund] = await db.select().from(refunds).where(eq(refunds.id, refund.data.refund.refundId));
    const storedAudits = await db.select().from(refundAudits).where(eq(refundAudits.refundId, storedRefund.id));
    const [refundedOrder] = await db.select().from(commerceOrders).where(eq(commerceOrders.id, refundableCheckout.data.order.orderId));
    const [refundedIntent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, refundableCheckout.data.order.paymentIntentId));
    assert.equal(storedRefund.status, "succeeded"); assert.equal(storedRefund.providerRefundId, refund.data.refund.providerRefundId); assert.ok(storedRefund.completedAt);
    assert.deepEqual(JSON.parse(storedRefund.providerResponse ?? "{}"), { provider: "internal_test", action: "refund", amount: 125, currency: "INR", idempotencyKey: refundKey });
    assert.deepEqual(storedAudits.map(row => row.eventType).sort(), ["refund.requested", "refund.succeeded"]);
    assert.equal(refundedOrder.status, "refunded"); assert.equal(refundedIntent.status, "refunded");
    assert.equal((await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, refundedOrder.id))).filter(row => row.eventType === "order.refunded").length, 1);
    const refundReplay = await post(adminToken, refundPath, { key: refundKey, reason: "Customer returned item" });
    assert.equal(refundReplay.status, 200); assert.deepEqual(refundReplay.data.refund, { ...refund.data.refund, replayed: true });
    const conflictingRefund = await post(adminToken, refundPath, { key: crypto.randomUUID(), reason: "Different refund request" });
    assert.equal(conflictingRefund.status, 409);
    assert.equal((await db.select().from(refunds).where(eq(refunds.orderId, refundedOrder.id))).length, 1);
    assert.equal((await db.select().from(refundAudits).where(eq(refundAudits.refundId, storedRefund.id))).length, 2);
    console.log("M-26/M-27/M-29/M-30: checkout and cancellation passed; admin provider refund persisted one provider result, refunded states, two audit events, one outbox event, and idempotent replay.");
  } finally {
    await db.delete(refundAudits).where(inArray(refundAudits.refundId, (await db.select({ id: refunds.id }).from(refunds).where(inArray(refunds.requestedBy, userIds.length ? userIds : [-1]))).map(row => row.id)));
    await db.delete(refunds).where(inArray(refunds.requestedBy, userIds.length ? userIds : [-1]));
    await db.delete(outboxEvents).where(eq(outboxEvents.aggregateType, "order"));
    await db.delete(paymentIntents).where(inArray(paymentIntents.orderId, (await db.select({ id: commerceOrders.id }).from(commerceOrders).where(eq(commerceOrders.buyerId, userIds[1] ?? -1))).map(row => row.id)));
    await db.delete(commerceOrders).where(inArray(commerceOrders.buyerId, userIds.length ? userIds : [-1]));
    await db.delete(carts).where(inArray(carts.buyerId, userIds.length ? userIds : [-1]));
    await db.delete(inventoryReservations).where(inArray(inventoryReservations.variantId, variantIds));
    await db.delete(warehouseStock).where(inArray(warehouseStock.variantId, variantIds));
    await db.delete(warehouses).where(eq(warehouses.id, warehouseId)); await db.delete(products).where(eq(products.id, productId));
    await db.delete(stores).where(eq(stores.id, storeId)); await db.delete(categories).where(eq(categories.id, tag)); if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
    await (db as ReturnType<typeof drizzlePostgres>).$client.end(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previousSecret === undefined) delete process.env.JWT_AUTH_SECRET; else process.env.JWT_AUTH_SECRET = previousSecret;
  }
});
