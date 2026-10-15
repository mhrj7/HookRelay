import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { getDb } from "../db";
import { cartItems, carts, categories, products, productVariants, stores, users } from "../db/schema";
import { issueAccessToken } from "../lib/api-tokens";
import { DELETE, GET, POST } from "../app/api/cart/route";

type Cart = { id: string | null; itemCount: number; total: number; items: Array<{ variantId: string; quantity: number; unitPrice: number; lineTotal: number; active: boolean }> };

test("M-25 HTTP: cart persists per buyer and always recalculates totals from active SKU prices", {
  skip: process.env.RUN_CART_INTEGRATION !== "1", timeout: 30000,
}, async () => {
  assert.match(process.env.DATABASE_URL ?? "", /@(db|localhost|127\.0\.0\.1)(:|\/)/);
  const previousSecret = process.env.JWT_AUTH_SECRET;
  process.env.JWT_AUTH_SECRET = crypto.randomUUID() + crypto.randomUUID();
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const request = new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method, headers, ...(["POST", "DELETE"].includes(incoming.method ?? "") ? { body: Buffer.concat(chunks).toString() } : {}) });
      const response = incoming.method === "GET" ? await GET(request) : incoming.method === "POST" ? await POST(request) : incoming.method === "DELETE" ? await DELETE(request) : new Response(null, { status: 405 });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
    } catch { outgoing.writeHead(500); outgoing.end("Test handler failed"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/cart`;
  const db = getDb(); const tag = crypto.randomUUID(); const userIds: number[] = [];
  const storeId = crypto.randomUUID(), productId = crypto.randomUUID(), variantId = crypto.randomUUID();
  async function call(token: string, method = "GET", body?: unknown) {
    const response = await fetch(base, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() as { cart?: Cart; error?: string } };
  }
  try {
    await db.execute(sql.raw(await readFile(new URL("../drizzle/0012_buyer_cart.sql", import.meta.url), "utf8")));
    const identities = ["seller", "buyer-a", "buyer-b", "admin"].map(role => `m25-${role}-${tag}`);
    for (let index = 0; index < identities.length; index++) {
      const [user] = await db.insert(users).values({ clerkId: identities[index], role: index === 0 ? "seller" : index === 3 ? "admin" : "buyer", sellerApprovalStatus: index === 0 ? "approved" : "not_requested" }).returning();
      userIds.push(user.id);
    }
    await db.insert(stores).values({ id: storeId, ownerId: userIds[0], name: "M25 local fixture", slug: tag, city: "Test", description: "Local only" });
    await db.insert(categories).values({ id: tag, name: "Test", slug: tag });
    await db.insert(products).values({ id: productId, storeId, categoryId: tag, title: "Current-price cart fixture", description: "Local only", price: 125 });
    await db.insert(productVariants).values({ id: variantId, productId, name: "Standard", sku: `M25-${tag}`, price: 125 });
    const [sellerToken, buyerAToken, buyerBToken, adminToken] = await Promise.all(identities.map(clerkId => issueAccessToken({ clerkId })));

    assert.equal((await call(buyerAToken, "POST", { variantId, quantity: 2 })).status, 200);
    const first = await call(buyerAToken); assert.equal(first.status, 200);
    assert.ok(first.data.cart?.id); assert.equal(first.data.cart?.itemCount, 2); assert.equal(first.data.cart?.total, 250);
    assert.deepEqual(first.data.cart?.items[0] && {
      variantId: first.data.cart.items[0].variantId,
      quantity: first.data.cart.items[0].quantity,
      unitPrice: first.data.cart.items[0].unitPrice,
      lineTotal: first.data.cart.items[0].lineTotal,
      active: first.data.cart.items[0].active,
    }, { variantId, quantity: 2, unitPrice: 125, lineTotal: 250, active: true });
    const persistedId = first.data.cart!.id;
    const fresh = await call(buyerAToken); assert.equal(fresh.data.cart?.id, persistedId, "Cart persists across independent buyer requests");
    const other = await call(buyerBToken); assert.equal(other.data.cart?.id, null); assert.deepEqual(other.data.cart?.items, []);

    await db.update(productVariants).set({ price: 150 }).where(eq(productVariants.id, variantId));
    const repriced = await call(buyerAToken); assert.equal(repriced.data.cart?.items[0].unitPrice, 150); assert.equal(repriced.data.cart?.total, 300);
    assert.equal((await call(buyerAToken, "POST", { variantId, quantity: 3 })).data.cart?.total, 450);
    await db.update(products).set({ status: "inactive" }).where(eq(products.id, productId));
    const inactive = await call(buyerAToken); assert.equal(inactive.data.cart?.items[0].active, false); assert.equal(inactive.data.cart?.items[0].lineTotal, 0); assert.equal(inactive.data.cart?.total, 0);
    assert.equal((await call(buyerAToken, "POST", { variantId, quantity: 4 })).status, 404);
    await db.update(products).set({ status: "active" }).where(eq(products.id, productId));

    assert.equal((await call(sellerToken, "POST", { variantId, quantity: 1 })).status, 404, "Seller cannot add own-store SKU");
    assert.equal((await call(adminToken)).status, 403, "Non-buyer role is denied");
    assert.equal((await call(buyerBToken, "DELETE", { variantId })).status, 404, "Another buyer cannot remove the item");
    assert.equal((await call(buyerAToken)).data.cart?.itemCount, 3);
    const removed = await call(buyerAToken, "DELETE", { variantId }); assert.equal(removed.status, 200); assert.equal(removed.data.cart?.itemCount, 0);
    assert.equal((await db.select().from(carts).where(eq(carts.buyerId, userIds[1]))).length, 1, "Empty cart remains buyer-owned and persistent");
    assert.equal((await db.select().from(cartItems).where(eq(cartItems.cartId, persistedId!))).length, 0);
    console.log("M-25: buyer-isolated persistent cart; 125→150 live repricing; inactive SKU excluded; ownership controls proven.");
  } finally {
    await db.delete(carts).where(inArray(carts.buyerId, userIds.length ? userIds : [-1]));
    await db.delete(products).where(eq(products.id, productId));
    await db.delete(stores).where(eq(stores.id, storeId)); await db.delete(categories).where(eq(categories.id, tag));
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
    await (db as ReturnType<typeof drizzlePostgres>).$client.end();
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previousSecret === undefined) delete process.env.JWT_AUTH_SECRET; else process.env.JWT_AUTH_SECRET = previousSecret;
  }
});
