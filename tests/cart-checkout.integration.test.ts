import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { getDb } from "../db";
import { cartItems, carts, categories, commerceOrderItems, commerceOrders, inventoryReservations, outboxEvents, paymentIntents, products, productVariants, stores, users, warehouses, warehouseStock } from "../db/schema";
import { issueAccessToken } from "../lib/api-tokens";
import { POST as cartPost } from "../app/api/cart/route";
import { POST as reservationPost } from "../app/api/checkout/reservations/route";
import { POST as checkoutPost } from "../app/api/checkout/orders/route";

type HttpData = {
  error?: string;
  reservation?: { id: string };
  order?: { orderId: string; paymentIntentId: string; outboxEventId: string; status: string; total: number; currency: string; replayed?: boolean };
};

test("M-26 HTTP: validated cart and reservations atomically create order, payment intent, and outbox", {
  skip: process.env.RUN_CART_CHECKOUT_INTEGRATION !== "1", timeout: 30000,
}, async () => {
  assert.match(process.env.DATABASE_URL ?? "", /@(db|localhost|127\.0\.0\.1)(:|\/)/);
  const previousSecret = process.env.JWT_AUTH_SECRET;
  process.env.JWT_AUTH_SECRET = crypto.randomUUID() + crypto.randomUUID();
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const request = new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method, headers, body: Buffer.concat(chunks).toString() });
      const path = new URL(request.url).pathname;
      const response = path === "/api/cart" ? await cartPost(request) : path === "/api/checkout/reservations" ? await reservationPost(request) : path === "/api/checkout/orders" ? await checkoutPost(request) : new Response(null, { status: 404 });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
    } catch { outgoing.writeHead(500); outgoing.end("Test handler failed"); }
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
  try {
    for (const file of ["0010_inventory_reservations.sql", "0011_reservation_release.sql", "0012_buyer_cart.sql", "0013_cart_checkout.sql", "0014_checkout_idempotency.sql"]) {
      await db.execute(sql.raw(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8")));
    }
    const clerkIds = ["seller", "buyer-a", "buyer-b"].map(role => `m26-${role}-${tag}`);
    for (let i = 0; i < clerkIds.length; i++) {
      const [user] = await db.insert(users).values({ clerkId: clerkIds[i], role: i ? "buyer" : "seller", sellerApprovalStatus: i ? "not_requested" : "approved" }).returning(); userIds.push(user.id);
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
    const [sellerToken, buyerAToken, buyerBToken] = await Promise.all(clerkIds.map(clerkId => issueAccessToken({ clerkId })));
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
    console.log("M-26/M-27: invalid checkout rolled back; valid checkout atomically created one record set; same key replayed identical IDs without duplicates; changed payload and reservation reuse rejected.");
  } finally {
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
