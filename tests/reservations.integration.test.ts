import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { getDb } from "../db";
import { categories, inventoryReservations, inventoryAudits, products, productVariants, stores, users, warehouses, warehouseStock } from "../db/schema";
import type { Actor } from "../lib/authorization";
import { buyerReservation, checkoutItem, reserveInventory } from "../lib/reservation-service";
import { setWarehouseStock, warehouseInventory } from "../lib/warehouse-service";

test("checkout holds: concurrency, retry, owner isolation, expiry and stock protection", { skip: process.env.RUN_RESERVATION_INTEGRATION !== "1" }, async () => {
  assert.match(process.env.DATABASE_URL ?? "", /@(db|localhost|127\.0\.0\.1)(:|\/)/);
  const db = getDb(); const tag = crypto.randomUUID(); const ids: number[] = [];
  const storeId = crypto.randomUUID(), productId = crypto.randomUUID(), variantId = crypto.randomUUID();
  const warehouseIds = [crypto.randomUUID(), crypto.randomUUID()];
  try {
    await db.execute(sql.raw(await readFile(new URL("../drizzle/0010_inventory_reservations.sql", import.meta.url), "utf8")));
    await db.execute(sql.raw(await readFile(new URL("../drizzle/0011_reservation_release.sql", import.meta.url), "utf8")));
    for (let i = 0; i < 4; i++) {
      const [u] = await db.insert(users).values({ clerkId: `${tag}-${i}`, role: i ? "buyer" : "seller", sellerApprovalStatus: "approved" }).returning(); ids.push(u.id);
    }
    await db.insert(stores).values({ id: storeId, ownerId: ids[0], name: "Reservation fixture", slug: tag, city: "Test", description: "Local only" });
    await db.insert(categories).values({ id: tag, name: "Test", slug: tag });
    await db.insert(products).values({ id: productId, storeId, categoryId: tag, title: "Fixture", description: "Test", price: 100 });
    await db.insert(productVariants).values({ id: variantId, productId, name: "Standard", sku: tag, price: 125 });
    for (const id of warehouseIds) {
      await db.insert(warehouses).values({ id, storeId, name: id, city: "Test", address: "Local fixture only", postcode: "560001" });
      await db.insert(warehouseStock).values({ warehouseId: id, variantId, quantity: 3 });
    }
    const actor = (i: number): Actor => ({ id: ids[i], clerkId: `${tag}-${i}`, role: i ? "buyer" : "seller", staffForSellerId: null, sellerApprovalStatus: "approved" });
    const input = (quantity: number) => ({ variantId, quantity, key: crypto.randomUUID() });
    assert.equal((await checkoutItem(variantId))?.available, 6);
    assert.equal((await reserveInventory(actor(0), input(1))).error, "own_store");
    assert.equal((await reserveInventory({ ...actor(1), role: "admin" }, input(1))).error, "forbidden");
    const request = input(4);
    const retry = await Promise.all([reserveInventory(actor(1), request), reserveInventory(actor(1), request)]);
    assert.ok(retry[0].id); assert.equal(retry[0].id, retry[1].id);
    assert.equal((await checkoutItem(variantId))?.available, 2, "Hold spans warehouses and reduces purchasable stock");
    assert.equal((await buyerReservation(actor(1), retry[0].id!))?.unitPrice, 125);
    assert.equal(await buyerReservation(actor(2), retry[0].id!), null);
    assert.equal((await reserveInventory(actor(1), { ...request, quantity: 3 })).error, "key_conflict");
    assert.equal((await reserveInventory(actor(1), input(1))).error, "already_held");
    const race = await Promise.all([reserveInventory(actor(2), input(2)), reserveInventory(actor(3), input(2))]);
    assert.equal(race.filter(r => r.id).length, 1); assert.equal(race.filter(r => r.error === "insufficient").length, 1);
    assert.equal((await checkoutItem(variantId))?.available, 0);
    await assert.rejects(setWarehouseStock(actor(0), storeId, warehouseIds[0], { variantId, quantity: 0, version: 1, reason: "Cannot overwrite holds" }));
    assert.equal((await warehouseInventory(actor(0), storeId, warehouseIds[0]))?.inventory[0].quantity, 3);
    // Only local owned fixtures: simulate elapsed DB time, without any release job.
    await db.update(inventoryReservations).set({ createdAt: new Date(Date.now() - 120000), expiresAt: new Date(Date.now() - 60000) }).where(eq(inventoryReservations.variantId, variantId));
    assert.equal((await buyerReservation(actor(1), retry[0].id!))?.status, "expired");
    assert.equal((await checkoutItem(variantId))?.available, 6);
    assert.equal((await reserveInventory(actor(1), request)).id, retry[0].id, "Retry does not renew an expired hold");
    assert.equal((await checkoutItem(variantId))?.available, 6);
    const next = await reserveInventory(actor(1), input(6)); assert.ok(next.id);
    assert.equal((await checkoutItem(variantId))?.available, 0);
    assert.equal((await db.select().from(warehouseStock).where(eq(warehouseStock.variantId, variantId))).reduce((n, s) => n + s.quantity, 0), 6, "Reservations never change physical stock");
    await db.update(inventoryReservations).set({ createdAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 200) }).where(eq(inventoryReservations.id, next.id!));
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal((await checkoutItem(variantId))?.available, 6, "Actual clock expiry restores availability without a worker");
    assert.equal((await checkoutItem(variantId))?.available, 6, "Repeated expiry reads do not double-release stock");
    await setWarehouseStock(actor(0), storeId, warehouseIds[0], { variantId, quantity: 0, version: 1, reason: "Allowed after expiry" });
    assert.equal((await checkoutItem(variantId))?.available, 3);
    await db.update(productVariants).set({ status: "inactive" }).where(eq(productVariants.id, variantId));
    assert.equal(await checkoutItem(variantId), null);
    assert.equal((await reserveInventory(actor(1), input(1))).error, "not_found");
  } finally {
    await db.delete(inventoryReservations).where(eq(inventoryReservations.variantId, variantId));
    await db.delete(inventoryAudits).where(eq(inventoryAudits.storeId, storeId));
    await db.delete(warehouseStock).where(eq(warehouseStock.variantId, variantId));
    await db.delete(warehouses).where(inArray(warehouses.id, warehouseIds));
    await db.delete(products).where(eq(products.id, productId));
    await db.delete(stores).where(eq(stores.id, storeId)); await db.delete(categories).where(eq(categories.id, tag));
    if (ids.length) await db.delete(users).where(inArray(users.id, ids));
    await (db as ReturnType<typeof drizzlePostgres>).$client.end();
  }
});
