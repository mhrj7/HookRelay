import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { getDb } from "../db";
import { categories, inventoryReservations, products, productVariants, stores, users, warehouses, warehouseStock } from "../db/schema";
import { issueAccessToken } from "../lib/api-tokens";
import { GET as availability } from "../app/api/checkout/availability/route";
import { POST as reserve } from "../app/api/checkout/reservations/route";
import { POST as paymentFailure } from "../app/api/checkout/reservations/[id]/payment-failure/route";

type Json = { error?: string; item?: { available: number }; reservation?: { id: string; status: string; releasedAt: string | null; releaseReason: string | null } };

test("M-24 HTTP: payment failure releases the exact hold and expiry never double-releases", {
  skip: process.env.RUN_RELEASE_INTEGRATION !== "1",
  timeout: 60000,
}, async () => {
  assert.match(process.env.DATABASE_URL ?? "", /@(db|localhost|127\.0\.0\.1)(:|\/)/);
  const previousSecret = process.env.JWT_AUTH_SECRET;
  process.env.JWT_AUTH_SECRET = crypto.randomUUID() + crypto.randomUUID();
  const db = getDb();
  const client = (db as ReturnType<typeof drizzlePostgres>).$client;
  const tag = crypto.randomUUID();
  const storeId = crypto.randomUUID(), productId = crypto.randomUUID(), variantId = crypto.randomUUID();
  const warehouseIds = [crypto.randomUUID(), crypto.randomUUID()];
  const userIds: number[] = [];
  const clerkIds = [0, 1, 2].map(i => `m24-local-${tag}-${i}`);
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const request = new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method,
        headers,
        ...(incoming.method === "POST" ? { body: Buffer.concat(chunks).toString() || undefined } : {}),
      });
      const pathname = new URL(request.url).pathname;
      let response: Response;
      if (incoming.method === "GET" && pathname === "/api/checkout/availability") response = await availability(request);
      else if (incoming.method === "POST" && pathname === "/api/checkout/reservations") response = await reserve(request);
      else {
        const match = pathname.match(/^\/api\/checkout\/reservations\/([^/]+)\/payment-failure$/);
        response = incoming.method === "POST" && match
          ? await paymentFailure(request, { params: Promise.resolve({ id: match[1] }) })
          : new Response(null, { status: 404 });
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    } catch {
      outgoing.writeHead(500);
      outgoing.end(JSON.stringify({ error: "Test handler failed" }));
    }
  });
  try {
    await db.execute(sql.raw(await readFile(new URL("../drizzle/0010_inventory_reservations.sql", import.meta.url), "utf8")));
    await db.execute(sql.raw(await readFile(new URL("../drizzle/0011_reservation_release.sql", import.meta.url), "utf8")));
    for (let i = 0; i < clerkIds.length; i++) {
      const [user] = await db.insert(users).values({ clerkId: clerkIds[i], role: i ? "buyer" : "seller", sellerApprovalStatus: i ? "not_requested" : "approved" }).returning();
      userIds.push(user.id);
    }
    await db.insert(stores).values({ id: storeId, ownerId: userIds[0], name: "M24 local fixture", slug: tag, city: "Test", description: "Local only" });
    await db.insert(categories).values({ id: tag, name: "Test", slug: tag });
    await db.insert(products).values({ id: productId, storeId, categoryId: tag, title: "Release fixture", description: "Local only", price: 100 });
    await db.insert(productVariants).values({ id: variantId, productId, name: "Standard", sku: tag, price: 125 });
    for (const [index, warehouseId] of warehouseIds.entries()) {
      await db.insert(warehouses).values({ id: warehouseId, storeId, name: `Warehouse ${index + 1}`, city: "Test", address: "Local only", postcode: "560001" });
      await db.insert(warehouseStock).values({ warehouseId, variantId, quantity: index === 0 ? 2 : 3 });
    }
    const tokens = await Promise.all(clerkIds.slice(1).map(clerkId => issueAccessToken({ clerkId })));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const call = async (path: string, token?: string, body?: object) => {
      const response = await fetch(`${base}${path}`, {
        method: body !== undefined ? "POST" : "GET",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000),
      });
      return { status: response.status, body: await response.json() as Json };
    };
    const available = async () => (await call(`/api/checkout/availability?variant=${variantId}`)).body.item?.available;

    assert.equal(await available(), 5);
    const held = await call("/api/checkout/reservations", tokens[0], { variantId, quantity: 4, key: crypto.randomUUID() });
    assert.equal(held.status, 200); assert.equal(held.body.reservation?.status, "held");
    const reservationId = held.body.reservation!.id;
    assert.equal(await available(), 1);
    const denied = await call(`/api/checkout/reservations/${reservationId}/payment-failure`, tokens[1], {});
    assert.equal(denied.status, 404, "Another buyer cannot release the hold");
    assert.equal(await available(), 1);

    const failed = await call(`/api/checkout/reservations/${reservationId}/payment-failure`, tokens[0], {});
    assert.equal(failed.status, 200); assert.equal(failed.body.reservation?.status, "released");
    assert.equal(failed.body.reservation?.releaseReason, "payment_failed");
    assert.ok(failed.body.reservation?.releasedAt);
    assert.equal(await available(), 5, "Payment failure restores the exact four held units");
    const releasedAt = failed.body.reservation!.releasedAt;
    const replay = await call(`/api/checkout/reservations/${reservationId}/payment-failure`, tokens[0], {});
    assert.equal(replay.status, 200); assert.equal(replay.body.reservation?.releasedAt, releasedAt, "Duplicate failure delivery is idempotent");
    const [audit] = await client`SELECT
      (SELECT sum(quantity)::integer FROM inventory_reservation_allocations WHERE reservation_id = ${reservationId}) AS retained_allocation,
      (SELECT sum(quantity)::integer FROM warehouse_stock WHERE variant_id = ${variantId}) AS physical_stock`;
    assert.equal(audit.retained_allocation, 4); assert.equal(audit.physical_stock, 5);

    const expiring = await call("/api/checkout/reservations", tokens[0], { variantId, quantity: 5, key: crypto.randomUUID() });
    assert.equal(expiring.status, 200); assert.equal(await available(), 0);
    await db.update(inventoryReservations).set({ createdAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 150) }).where(eq(inventoryReservations.id, expiring.body.reservation!.id));
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await available(), 5, "Natural expiry restores availability");
    const expiredFailure = await call(`/api/checkout/reservations/${expiring.body.reservation!.id}/payment-failure`, tokens[0], {});
    assert.equal(expiredFailure.status, 200); assert.equal(expiredFailure.body.reservation?.status, "expired");
    assert.equal(expiredFailure.body.reservation?.releasedAt, null);
    assert.equal(await available(), 5, "Failure after expiry cannot double-release");
    console.log("M-24: held 4 of 5; payment failure restored 5 available; retry preserved one release timestamp; expiry restored 5 without double release; physical stock remained 5.");
  } finally {
    if (variantId) await db.delete(inventoryReservations).where(eq(inventoryReservations.variantId, variantId));
    await db.delete(warehouseStock).where(eq(warehouseStock.variantId, variantId));
    await db.delete(warehouses).where(inArray(warehouses.id, warehouseIds));
    await db.delete(products).where(eq(products.id, productId));
    await db.delete(stores).where(eq(stores.id, storeId));
    await db.delete(categories).where(eq(categories.id, tag));
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await client.end();
    if (previousSecret === undefined) delete process.env.JWT_AUTH_SECRET;
    else process.env.JWT_AUTH_SECRET = previousSecret;
  }
});
