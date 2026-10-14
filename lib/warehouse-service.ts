import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { inventoryAudits, productVariants, products, stores, warehouses, warehouseStock } from "../db/schema";
import { Actor, canManageSeller } from "./authorization";

export async function accessibleStore(actor: Actor, storeId: string) {
  const [store] = await getDb().select().from(stores).where(eq(stores.id, storeId)).limit(1);
  return store && canManageSeller(actor, store.ownerId) ? store : null;
}

export async function warehouseInventory(actor: Actor, storeId: string, warehouseId: string) {
  if (!await accessibleStore(actor, storeId)) return null;
  const db = getDb();
  const [warehouse] = await db.select().from(warehouses).where(and(eq(warehouses.id, warehouseId), eq(warehouses.storeId, storeId))).limit(1);
  if (!warehouse) return null;
  const inventory = await db.select({ variantId: productVariants.id, sku: productVariants.sku, name: productVariants.name, title: products.title,
    quantity: sql<number>`coalesce(${warehouseStock.quantity}, 0)`, version: sql<number>`coalesce(${warehouseStock.version}, 0)`,
    reserved: sql<number>`coalesce((SELECT sum(a.quantity)::integer FROM inventory_reservation_allocations a JOIN inventory_reservations r ON r.id = a.reservation_id WHERE a.variant_id = ${productVariants.id} AND a.warehouse_id = ${warehouseId} AND r.expires_at > CURRENT_TIMESTAMP AND r.released_at IS NULL), 0)` })
    .from(productVariants).innerJoin(products, eq(productVariants.productId, products.id))
    .leftJoin(warehouseStock, and(eq(warehouseStock.variantId, productVariants.id), eq(warehouseStock.warehouseId, warehouseId)))
    .where(eq(products.storeId, storeId)).orderBy(asc(productVariants.sku));
  const history = await db.select().from(inventoryAudits).where(and(eq(inventoryAudits.storeId, storeId), eq(inventoryAudits.warehouseId, warehouseId))).orderBy(desc(inventoryAudits.createdAt), desc(inventoryAudits.id)).limit(100);
  return { warehouse, inventory, history };
}

export async function setWarehouseStock(actor: Actor, storeId: string, warehouseId: string, input: { variantId: string; quantity: number; version: number; reason?: string }): Promise<typeof warehouseStock.$inferSelect | "not_found" | "conflict"> {
  if (!await accessibleStore(actor, storeId)) return "not_found";
  const db = getDb();
  const [warehouse] = await db.select().from(warehouses).where(and(eq(warehouses.id, warehouseId), eq(warehouses.storeId, storeId))).limit(1);
  const [variant] = await db.select({ id: productVariants.id, sku: productVariants.sku }).from(productVariants).innerJoin(products, eq(productVariants.productId, products.id))
    .where(and(eq(products.storeId, storeId), eq(productVariants.id, input.variantId))).limit(1);
  if (!warehouse || !variant) return "not_found";
  // One SQL statement works with both Neon HTTP and local Postgres. The audit
  // INSERT consumes only successful compare-and-set writes; either both commit
  // or neither does. A row lock captures the exact previous quantity.
  const changed = input.version === 0 ? sql`
    INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity)
    VALUES (${warehouseId}, ${input.variantId}, ${input.quantity})
    ON CONFLICT DO NOTHING RETURNING *, 0 AS previous_quantity
  ` : sql`
    UPDATE warehouse_stock AS stock SET quantity = ${input.quantity}, version = stock.version + 1,
      updated_at = ${new Date().toISOString()}
    FROM locked WHERE stock.warehouse_id = locked.warehouse_id AND stock.variant_id = locked.variant_id
      AND stock.version = ${input.version}
    RETURNING stock.*, locked.quantity AS previous_quantity
  `;
  const result = await db.execute(sql`
    WITH locked AS (
      SELECT * FROM warehouse_stock WHERE warehouse_id = ${warehouseId}
        AND variant_id = ${input.variantId} AND version = ${input.version} FOR UPDATE
    ), changed AS (${changed}), logged AS (
      INSERT INTO inventory_audits (id, store_id, warehouse_id, variant_id, actor_id, actor_role, sku,
        previous_quantity, quantity, stock_version, reason)
      SELECT ${crypto.randomUUID()}, ${storeId}, warehouse_id, variant_id, ${actor.id}, ${actor.role}, ${variant.sku},
        previous_quantity, quantity, version, ${input.reason ?? "Manual stock update"} FROM changed
      RETURNING id
    ) SELECT warehouse_id AS "warehouseId", variant_id AS "variantId", quantity, version, updated_at AS "updatedAt"
      FROM changed WHERE EXISTS (SELECT 1 FROM logged)
  `);
  const rows = (Array.isArray(result) ? result : result.rows) as (typeof warehouseStock.$inferSelect)[];
  return rows[0] ?? "conflict";
}
