import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { eq, inArray } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { getDb } from "../db";
import { categories, inventoryReservations, products, productVariants, stores, users, warehouses, warehouseStock } from "../db/schema";
import { issueAccessToken } from "../lib/api-tokens";
import { POST } from "../app/api/checkout/reservations/route";
import { GET } from "../app/api/checkout/availability/route";

type Result = { status: number; body: { error?: string; reservation?: { id: string; quantity: number; expiresAt: string; status: string } } };

test("M-23 HTTP: exactly one of two buyers reserves the final unit, with proven lock contention", {
  skip: process.env.RUN_OVERSELL_INTEGRATION !== "1", timeout: 60000,
}, async () => {
  // This test creates/deletes only its own random local fixtures. Never target
  // production, mint identities for real users, or print authentication tokens.
  assert.match(process.env.DATABASE_URL ?? "", /@(db|localhost|127\.0\.0\.1)(:|\/)/);
  const previousSecret = process.env.JWT_AUTH_SECRET;
  process.env.JWT_AUTH_SECRET = crypto.randomUUID() + crypto.randomUUID();
  // Real HTTP transport -> unchanged application handlers -> real local SQL.
  // Clerk UI/proxy are not under test; synthetic buyers use the existing JWT API.
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const request = new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method, headers,
        ...(incoming.method === "POST" ? { body: Buffer.concat(chunks).toString() } : {}),
      });
      const response = incoming.method === "POST" && new URL(request.url).pathname === "/api/checkout/reservations"
        ? await POST(request) : incoming.method === "GET" && new URL(request.url).pathname === "/api/checkout/availability"
          ? await GET(request) : new Response(null, { status: 404 });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    } catch { outgoing.writeHead(500); outgoing.end("Test handler failed"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = new URL(`http://127.0.0.1:${address.port}`);
  const db = getDb(); const client = (db as ReturnType<typeof drizzlePostgres>).$client;
  const tag = crypto.randomUUID(), storeId = crypto.randomUUID(), productId = crypto.randomUUID(), warehouseId = crypto.randomUUID();
  const buyerIds: number[] = [], variantIds: string[] = [], userIds: number[] = [];
  const clerkIds = [0, 1, 2].map(i => `m23-local-${tag}-${i}`);
  const requests: Promise<Result>[] = [];
  let lock: Awaited<ReturnType<typeof client.reserve>> | undefined;
  async function checkout(token: string, body: { variantId: string; quantity: number; key: string }): Promise<Result> {
    const response = await fetch(new URL("/api/checkout/reservations", base), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: "error",
    });
    return { status: response.status, body: await response.json() };
  }
  try {
    // Verify handlers can reach SQL before the contention test.
    const baseline = await fetch(new URL("/api/checkout/availability?variant=m23-no-such-sku", base), { signal: AbortSignal.timeout(15000) });
    assert.equal(baseline.status, 404, "Local server must have the reservation migration installed");
    for (let i = 0; i < clerkIds.length; i++) {
      const [u] = await db.insert(users).values({ clerkId: clerkIds[i], role: i ? "buyer" : "seller", sellerApprovalStatus: i ? "not_requested" : "approved" }).returning();
      userIds.push(u.id); if (i) buyerIds.push(u.id);
    }
    await db.insert(stores).values({ id: storeId, ownerId: userIds[0], name: "M23 local fixture", slug: tag, city: "Test", description: "Local only" });
    await db.insert(categories).values({ id: tag, name: "Test", slug: tag });
    await db.insert(products).values({ id: productId, storeId, categoryId: tag, title: "Final unit test", description: "Local only", price: 100 });
    await db.insert(warehouses).values({ id: warehouseId, storeId, name: "M23 local warehouse", city: "Test", address: "Local fixture", postcode: "560001" });
    const tokens = await Promise.all(clerkIds.slice(1).map(clerkId => issueAccessToken({ clerkId })));
    for (let round = 1; round <= 5; round++) {
      const variantId = crypto.randomUUID(); variantIds.push(variantId);
      await db.insert(productVariants).values({ id: variantId, productId, name: `Round ${round}`, sku: `${tag}-${round}`, price: 100 });
      await db.insert(warehouseStock).values({ warehouseId, variantId, quantity: 1 });
      const bodies = tokens.map(() => ({ variantId, quantity: 1, key: crypto.randomUUID() }));
      lock = await client.reserve();
      await lock`BEGIN`;
      await lock`SELECT id FROM product_variants WHERE id = ${variantId} FOR UPDATE`;
      const pair = tokens.map((token, i) => checkout(token, bodies[i])); requests.push(...pair);
      // Attach rejection handlers immediately while observing lock waiters.
      const settled = Promise.allSettled(pair);
      let waiting = 0;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const [state] = await client`SELECT count(*)::integer AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query LIKE '%reserve_inventory(%'`;
        waiting = state.waiting;
        if (waiting >= 2) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(waiting >= 2, "Both independent HTTP requests must reach PostgreSQL and wait before release");
      await lock`COMMIT`; lock.release(); lock = undefined;
      const results = await settled;
      assert.ok(results.every(r => r.status === "fulfilled"), "Both requests must return a response");
      const outcomes = results.map(r => (r as PromiseFulfilledResult<Result>).value);
      assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409]);
      const winner = outcomes.findIndex(r => r.status === 200), loser = 1 - winner;
      assert.equal(outcomes[winner].body.reservation?.quantity, 1);
      assert.equal(outcomes[winner].body.reservation?.status, "held");
      assert.match(outcomes[loser].body.error ?? "", /Not enough available stock/);
      const records = await db.select().from(inventoryReservations).where(eq(inventoryReservations.variantId, variantId));
      assert.equal(records.length, 1); assert.equal(records[0].buyerId, buyerIds[winner]);
      const [counts] = await client`SELECT
        (SELECT sum(quantity)::integer FROM inventory_reservation_allocations WHERE variant_id = ${variantId}) AS allocated,
        (SELECT quantity FROM warehouse_stock WHERE variant_id = ${variantId} AND warehouse_id = ${warehouseId}) AS physical`;
      assert.equal(counts.allocated, 1); assert.equal(counts.physical, 1);
      const availability = await fetch(new URL(`/api/checkout/availability?variant=${variantId}`, base));
      assert.equal(availability.status, 200); assert.equal((await availability.json()).item.available, 0);
      const replay = await checkout(tokens[winner], bodies[winner]);
      assert.equal(replay.status, 200); assert.equal(replay.body.reservation?.id, outcomes[winner].body.reservation?.id);
      assert.equal(replay.body.reservation?.expiresAt, outcomes[winner].body.reservation?.expiresAt);
      const retry = await checkout(tokens[loser], { ...bodies[loser], key: crypto.randomUUID() });
      assert.equal(retry.status, 409);
      assert.equal((await db.select().from(inventoryReservations).where(eq(inventoryReservations.variantId, variantId))).length, 1);
      console.log(`M-23 round ${round}: 2 lock-waiting HTTP buyers; statuses 200/409; 1 reservation, 1 allocated, 0 available; retry unchanged.`);
    }
  } finally {
    if (lock) { await lock`ROLLBACK`; lock.release(); }
    await Promise.allSettled(requests);
    if (variantIds.length) {
      await db.delete(inventoryReservations).where(inArray(inventoryReservations.variantId, variantIds));
      await db.delete(warehouseStock).where(inArray(warehouseStock.variantId, variantIds));
    }
    await db.delete(warehouses).where(eq(warehouses.id, warehouseId));
    await db.delete(products).where(eq(products.id, productId));
    await db.delete(stores).where(eq(stores.id, storeId)); await db.delete(categories).where(eq(categories.id, tag));
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
    await client.end();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previousSecret === undefined) delete process.env.JWT_AUTH_SECRET;
    else process.env.JWT_AUTH_SECRET = previousSecret;
  }
});
