import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { getDb } from "../db";
import { cartItems, carts, categories, commerceOrderItems, commerceOrders, inventoryReservations, outboxEvents, paymentIntents, products, productVariants, refundAudits, refunds, stores, users, warehouses, warehouseStock } from "../db/schema";
import { issueAccessToken } from "../lib/api-tokens";
import { POST as cartPost } from "../app/api/cart/route";
import { POST as reservationPost } from "../app/api/checkout/reservations/route";
import { POST as checkoutPost } from "../app/api/checkout/orders/route";
import { POST as cancellationPost } from "../app/api/checkout/orders/[id]/cancel/route";
import { GET as availabilityGet } from "../app/api/checkout/availability/route";
import { POST as refundPost } from "../app/api/checkout/orders/[id]/refunds/route";
import { POST as paymentPost, PATCH as paymentPatch } from "../app/api/checkout/orders/[id]/payment/route";
import { GET as commissionGet } from "../app/api/admin/commissions/route";
import { createInternalTestSignature } from "../lib/payment-provider";

type HttpData = {
  error?: string;
  reservation?: { id: string };
  order?: { orderId: string; paymentIntentId: string; outboxEventId: string; status: string; total: number; currency: string; replayed?: boolean };
  cancellation?: { orderId: string; status: string; cancelledAt: string; outboxEventId: string; releasedQuantity: number; replayed: boolean };
  refund?: { refundId: string; paymentIntentId: string; providerPaymentId: string; provider: string; providerRefundId: string; amount: number; currency: string; reason: string; status: string; completedAt: string; outboxEventId: string; replayed: boolean };
  item?: { available: number };
  payment?: { providerOrderId: string; paymentIntentId: string; status: string; replayed?: boolean };
};

test("M-26/M-27/M-29/M-30 HTTP: checkout, cancellation, and authorized refund workflows persist exact effects", {
  skip: process.env.RUN_CART_CHECKOUT_INTEGRATION !== "1", timeout: process.env.ALLOW_NEON_M42_INTEGRATION === "1" ? 120000 : 30000,
}, async () => {
  if (process.env.ALLOW_NEON_M42_INTEGRATION !== "1") assert.match(process.env.DATABASE_URL ?? "", /@(db|localhost|127\.0\.0\.1)(:|\/)/);
  const previousSecret = process.env.JWT_AUTH_SECRET;
  const previousPaymentProvider = process.env.COMMERCE_PAYMENT_PROVIDER;
  process.env.JWT_AUTH_SECRET = crypto.randomUUID() + crypto.randomUUID();
  process.env.COMMERCE_PAYMENT_PROVIDER = "internal_test";
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const body = Buffer.concat(chunks).toString();
      const request = new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method, headers, ...(incoming.method === "GET" || incoming.method === "HEAD" ? {} : { body }) });
      const path = new URL(request.url).pathname;
      const cancelMatch = path.match(/^\/api\/checkout\/orders\/([^/]+)\/cancel$/);
      const refundMatch = path.match(/^\/api\/checkout\/orders\/([^/]+)\/refunds$/);
      const paymentMatch = path.match(/^\/api\/checkout\/orders\/([^/]+)\/payment$/);
      const response = path === "/api/cart" ? await cartPost(request)
        : path === "/api/checkout/reservations" ? await reservationPost(request)
          : path === "/api/checkout/orders" ? await checkoutPost(request)
            : path === "/api/checkout/availability" ? await availabilityGet(request)
              : cancelMatch ? await cancellationPost(request, { params: Promise.resolve({ id: cancelMatch[1] }) })
                : paymentMatch && request.method === "POST" ? await paymentPost(request, { params: Promise.resolve({ id: paymentMatch[1] }) })
                  : paymentMatch && request.method === "PATCH" ? await paymentPatch(request, { params: Promise.resolve({ id: paymentMatch[1] }) })
                : refundMatch ? await refundPost(request, { params: Promise.resolve({ id: refundMatch[1] }) })
                : new Response(null, { status: 404 });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
    } catch (error) { console.error(error); outgoing.writeHead(500); outgoing.end("Test handler failed"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const db = getDb(); const direct = postgres(process.env.DATABASE_URL!, { max: 1 }); const tag = crypto.randomUUID(); const userIds: number[] = [];
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
  async function fixtureCounts() {
    const result = await db.execute(sql`SELECT
      (SELECT count(*)::int FROM commerce_orders WHERE buyer_id = ${userIds[1] ?? -1}) AS orders,
      (SELECT count(*)::int FROM payment_intents WHERE order_id IN (SELECT id FROM commerce_orders WHERE buyer_id = ${userIds[1] ?? -1})) AS intents,
      (SELECT count(*)::int FROM outbox_events WHERE aggregate_type = 'order' AND aggregate_id IN (SELECT id FROM commerce_orders WHERE buyer_id = ${userIds[1] ?? -1})) AS events`);
    const rows = (Array.isArray(result) ? result : result.rows) as Array<{ orders: number; intents: number; events: number }>;
    return rows[0];
  }
  try {
    if (process.env.ALLOW_NEON_M42_INTEGRATION !== "1") {
      for (const file of ["0010_inventory_reservations.sql", "0011_reservation_release.sql", "0012_buyer_cart.sql", "0013_cart_checkout.sql", "0014_checkout_idempotency.sql", "0015_order_cancellation.sql", "0016_refund_workflow.sql", "0017_notifications.sql", "0019_commission_rate_snapshot.sql", "0020_commerce_payment_capture.sql", "0021_refund_provider_payment.sql", "0023_transactional_outbox_guards.sql"]) {
        await db.execute(sql.raw(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8")));
      }
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

    const unpairedOrderId = crypto.randomUUID();
    await assert.rejects(direct.begin(async tx => {
      await tx`INSERT INTO commerce_orders(id, buyer_id, idempotency_key, request_fingerprint, total) VALUES (${unpairedOrderId}, ${userIds[1]}, ${`m44-${tag}-missing-event`}, ${tag}, 100)`;
      await tx`INSERT INTO payment_intents(id, order_id, amount) VALUES (${crypto.randomUUID()}, ${unpairedOrderId}, 100)`;
    }), /order\.created|without order/i, "an order and payment intent cannot commit without their domain outbox event");
    assert.equal((await db.select().from(commerceOrders).where(eq(commerceOrders.id, unpairedOrderId))).length, 0, "the unmatched domain rows roll back");

    const orphanOrderId = crypto.randomUUID(); const orphanEventId = crypto.randomUUID();
    await assert.rejects(direct.begin(async tx => {
      await tx`INSERT INTO outbox_events(id, aggregate_type, aggregate_id, event_type, payload) VALUES (${orphanEventId}, 'order', ${orphanOrderId}, 'order.created', ${JSON.stringify({ orderId: orphanOrderId })})`;
    }), /missing order/i, "an outbox event cannot commit without its domain order");
    assert.equal((await db.select().from(outboxEvents).where(eq(outboxEvents.id, orphanEventId))).length, 0, "the orphan event rolls back");

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
    assert.deepEqual(await fixtureCounts(), { orders: 0, intents: 0, events: 0 });
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

    await assert.rejects(direct.begin(async tx => {
      await tx`UPDATE payment_intents SET status = 'succeeded' WHERE id = ${intent.id}`;
      await tx`UPDATE commerce_orders SET status = 'paid' WHERE id = ${order.id}`;
    }), /without order\.paid/i, "paid domain state cannot commit without order.paid");
    assert.equal((await db.select().from(commerceOrders).where(eq(commerceOrders.id, order.id)))[0].status, "pending_payment", "the unmatched payment/order transition rolls back");
    assert.equal((await db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id)))[0].status, "requires_payment_method");

    const prematurePaidEventId = crypto.randomUUID();
    await assert.rejects(direct.begin(async tx => {
      await tx`INSERT INTO outbox_events(id, aggregate_type, aggregate_id, event_type, payload) VALUES (${prematurePaidEventId}, 'order', ${order.id}, 'order.paid', ${JSON.stringify({ orderId: order.id })})`;
    }), /matching domain state/i, "order.paid cannot commit before the payment/order transition");
    assert.equal((await db.select().from(outboxEvents).where(eq(outboxEvents.id, prematurePaidEventId))).length, 0, "the premature event rolls back");

    const changedPayload = await post(buyerAToken, "/api/checkout/orders", { key: checkoutKey, reservationIds: [reservationIds[0]] });
    assert.equal(changedPayload.status, 409); assert.match(changedPayload.data.error ?? "", /idempotency key/i);
    assert.deepEqual(await fixtureCounts(), { orders: 1, intents: 1, events: 1 });

    assert.equal((await post(buyerAToken, "/api/cart", { variantId: variantIds[0], quantity: 2 })).status, 200);
    const reused = await post(buyerAToken, "/api/checkout/orders", { key: crypto.randomUUID(), reservationIds: [reservationIds[0]] });
    assert.equal(reused.status, 409); assert.deepEqual(await fixtureCounts(), { orders: 1, intents: 1, events: 1 });

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
    const paymentPath = `/api/checkout/orders/${refundableCheckout.data.order.orderId}/payment`;
    const payment = await post(buyerAToken, paymentPath, {});
    assert.equal(payment.status, 200); assert.ok(payment.data.payment?.providerOrderId);
    const providerPaymentId = `pay_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const captured = await fetch(`${origin}${paymentPath}`, { method: "PATCH", headers: { Authorization: `Bearer ${buyerAToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ providerOrderId: payment.data.payment.providerOrderId, providerPaymentId, signature: createInternalTestSignature(payment.data.payment.providerOrderId, providerPaymentId) }) });
    const capturedData = await captured.json() as HttpData;
    assert.equal(captured.status, 200); assert.equal(capturedData.payment?.status, "paid");
    const [paidIntent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, refundableCheckout.data.order.paymentIntentId));
    assert.equal(paidIntent.providerPaymentId, providerPaymentId); assert.equal(paidIntent.status, "succeeded");
    assert.equal((await availability(variantIds[0])).data.item?.available, 9, "Captured payment consumes one physical unit");
    const commissionRequest = (token: string) => new Request(`${origin}/api/admin/commissions`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await commissionGet(commissionRequest(buyerAToken))).status, 403);
    const paidReport = await commissionGet(commissionRequest(adminToken));
    assert.equal(paidReport.status, 200);
    const paidData = await paidReport.json();
    const paidLine = paidData.items.find((item: { orderId: string }) => item.orderId === refundableCheckout.data.order!.orderId);
    assert.equal(paidLine.variantId, variantIds[0]);
    assert.equal(paidLine.commissionRateBps, 500);
    assert.equal(paidLine.netCommissionPaise, 625);
    await assert.rejects(db.update(commerceOrderItems).set({ commissionRateBps: 750 }).where(eq(commerceOrderItems.orderId, refundableCheckout.data.order.orderId)));
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
    const refundedReport = await commissionGet(commissionRequest(adminToken));
    assert.equal(refundedReport.status, 200);
    const refundedData = await refundedReport.json();
    const refundedLine = refundedData.items.find((item: { orderId: string }) => item.orderId === refundableCheckout.data.order!.orderId);
    assert.equal(refundedLine.refundId, storedRefund.id);
    assert.equal(refundedLine.reversalPaise, 625);
    assert.equal(refundedLine.netCommissionPaise, 0);
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
    await direct.begin(async tx => {
      const orderRows = await tx`SELECT id FROM commerce_orders WHERE buyer_id = ${userIds[1] ?? -1}`;
      const orderIds = orderRows.map(row => row.id as string);
      await tx`DELETE FROM refund_audits WHERE refund_id IN (SELECT id FROM refunds WHERE requested_by = ANY(${userIds.length ? userIds : [-1]}::int[]))`;
      await tx`DELETE FROM refunds WHERE requested_by = ANY(${userIds.length ? userIds : [-1]}::int[])`;
      await tx`DELETE FROM outbox_events WHERE aggregate_type = 'order' AND aggregate_id = ANY(${orderIds.length ? orderIds : ["-1"]}::text[])`;
      await tx`DELETE FROM payment_intents WHERE order_id = ANY(${orderIds.length ? orderIds : ["-1"]}::text[])`;
      await tx`DELETE FROM commerce_orders WHERE buyer_id = ANY(${userIds.length ? userIds : [-1]}::int[])`;
      await tx`DELETE FROM carts WHERE buyer_id = ANY(${userIds.length ? userIds : [-1]}::int[])`;
      await tx`DELETE FROM inventory_reservations WHERE variant_id = ANY(${variantIds}::text[])`;
      await tx`DELETE FROM warehouse_stock WHERE variant_id = ANY(${variantIds}::text[])`;
      await tx`DELETE FROM warehouses WHERE id = ${warehouseId}`; await tx`DELETE FROM products WHERE id = ${productId}`;
      await tx`DELETE FROM stores WHERE id = ${storeId}`; await tx`DELETE FROM categories WHERE id = ${tag}`;
      // M-43 audit rows are immutable and keep actor foreign keys; disposable
      // test databases/branches should be discarded instead of deleting actors.
    });
    await direct.end();
    const databaseClient = (db as unknown as { $client?: { end?: () => Promise<void> } }).$client;
    if (typeof databaseClient?.end === "function") await databaseClient.end();
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previousSecret === undefined) delete process.env.JWT_AUTH_SECRET; else process.env.JWT_AUTH_SECRET = previousSecret;
    if (previousPaymentProvider === undefined) delete process.env.COMMERCE_PAYMENT_PROVIDER; else process.env.COMMERCE_PAYMENT_PROVIDER = previousPaymentProvider;
  }
});
