import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { type Actor, canBuy } from "./authorization";

export type CheckoutItem = { id: string; title: string; name: string; sku: string; price: number; slug: string; available: number };
export type Reservation = { id: string; variantId: string; quantity: number; unitPrice: number; expiresAt: string; releasedAt: string | null; releaseReason: string | null; serverNow: string; status: "held" | "expired" | "released"; title: string; sku: string };
async function rows<T>(query: Parameters<ReturnType<typeof getDb>["execute"]>[0]): Promise<T[]> {
  const result = await getDb().execute(query);
  return (Array.isArray(result) ? result : result.rows) as T[];
}
export async function checkoutItem(variantId: string) {
  const result = await rows<CheckoutItem>(sql`
    SELECT v.id, p.title, v.name, v.sku, v.price, s.slug,
      coalesce((SELECT sum(greatest(0, stock.quantity - coalesce((
        SELECT sum(a.quantity) FROM inventory_reservation_allocations a JOIN inventory_reservations r ON r.id = a.reservation_id
        WHERE a.variant_id = stock.variant_id AND a.warehouse_id = stock.warehouse_id AND r.expires_at > CURRENT_TIMESTAMP AND r.released_at IS NULL
      ), 0)))::integer FROM warehouse_stock stock WHERE stock.variant_id = v.id), 0) AS available
    FROM product_variants v JOIN products p ON p.id = v.product_id JOIN stores s ON s.id = p.store_id JOIN users u ON u.id = s.owner_id
    WHERE v.id = ${variantId} AND v.status = 'active' AND p.status = 'active' AND s.is_public
      AND (u.seller_approval_status = 'approved' OR u.role = 'admin') AND v.price > 0
  `);
  return result[0] ?? null;
}
export async function buyerReservation(actor: Actor, id: string) {
  const result = await rows<Reservation>(sql`
    SELECT r.id, r.variant_id AS "variantId", r.quantity, r.unit_price AS "unitPrice",
      r.expires_at::text AS "expiresAt", r.released_at::text AS "releasedAt", r.release_reason AS "releaseReason", CURRENT_TIMESTAMP::text AS "serverNow",
      CASE WHEN r.released_at IS NOT NULL THEN 'released' WHEN r.expires_at > CURRENT_TIMESTAMP THEN 'held' ELSE 'expired' END AS status,
      p.title, v.sku FROM inventory_reservations r JOIN product_variants v ON v.id = r.variant_id JOIN products p ON p.id = v.product_id
    WHERE r.id = ${id} AND r.buyer_id = ${actor.id}
  `);
  return result[0] ?? null;
}
export function reservationInput(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.variantId !== "string" || !/^[\w-]{1,100}$/.test(input.variantId) ||
    typeof input.quantity !== "number" || !Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 20 ||
    typeof input.key !== "string" || !/^[\w-]{16,80}$/.test(input.key) || Object.keys(input).some(k => !["variantId", "quantity", "key"].includes(k))) return null;
  return { variantId: input.variantId, quantity: input.quantity, key: input.key };
}
export async function reserveInventory(actor: Actor, input: NonNullable<ReturnType<typeof reservationInput>>) {
  if (!canBuy(actor)) return { error: "forbidden" };
  const [result] = await rows<{ outcome: { id?: string; error?: string; available?: number } }>(sql`
    SELECT reserve_inventory(${crypto.randomUUID()}, ${actor.id}, ${input.variantId}, ${input.quantity}, ${input.key}) AS outcome
  `);
  return result.outcome;
}

export async function releaseAfterPaymentFailure(actor: Actor, reservationId: string) {
  if (!canBuy(actor)) return { error: "forbidden" };
  const [result] = await rows<{ outcome: { id?: string; error?: string; status?: string } }>(sql`
    SELECT release_inventory_after_payment_failure(${reservationId}, ${actor.id}) AS outcome
  `);
  return result.outcome;
}
