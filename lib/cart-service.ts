import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { type Actor, canBuy } from "./authorization";

export type CartItem = {
  variantId: string;
  productId: string;
  title: string;
  name: string;
  sku: string;
  slug: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  active: boolean;
};
export type CartSummary = { id: string | null; items: CartItem[]; total: number; itemCount: number };

async function rows<T>(query: Parameters<ReturnType<typeof getDb>["execute"]>[0]): Promise<T[]> {
  const result = await getDb().execute(query);
  return (Array.isArray(result) ? result : result.rows) as T[];
}

export function cartItemInput(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.variantId !== "string" || !/^[\w-]{1,100}$/.test(input.variantId) ||
    typeof input.quantity !== "number" || !Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 20 ||
    Object.keys(input).some(key => !["variantId", "quantity"].includes(key))) return null;
  return { variantId: input.variantId, quantity: input.quantity };
}

export async function buyerCart(actor: Actor): Promise<CartSummary | null> {
  if (!canBuy(actor)) return null;
  const cartRows = await rows<{ id: string }>(sql`SELECT id FROM carts WHERE buyer_id = ${actor.id}`);
  if (!cartRows[0]) return { id: null, items: [], total: 0, itemCount: 0 };
  const items = await rows<CartItem>(sql`
    SELECT ci.variant_id AS "variantId", p.id AS "productId", p.title, v.name, v.sku, s.slug,
      ci.quantity, v.price AS "unitPrice",
      CASE WHEN v.status = 'active' AND p.status = 'active' AND s.is_public
        AND (owner.seller_approval_status = 'approved' OR owner.role = 'admin')
        THEN v.price * ci.quantity ELSE 0 END::integer AS "lineTotal",
      (v.status = 'active' AND p.status = 'active' AND s.is_public
        AND (owner.seller_approval_status = 'approved' OR owner.role = 'admin')) AS active
    FROM cart_items ci
    JOIN product_variants v ON v.id = ci.variant_id
    JOIN products p ON p.id = v.product_id
    JOIN stores s ON s.id = p.store_id
    JOIN users owner ON owner.id = s.owner_id
    WHERE ci.cart_id = ${cartRows[0].id}
    ORDER BY ci.created_at, ci.variant_id
  `);
  return {
    id: cartRows[0].id,
    items,
    total: items.reduce((sum, item) => sum + item.lineTotal, 0),
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
  };
}

export async function setBuyerCartItem(actor: Actor, input: NonNullable<ReturnType<typeof cartItemInput>>) {
  if (!canBuy(actor)) return { error: "forbidden" };
  const id = crypto.randomUUID();
  const result = await rows<{ cartId: string }>(sql`
    WITH eligible AS (
      SELECT v.id FROM product_variants v
      JOIN products p ON p.id = v.product_id
      JOIN stores s ON s.id = p.store_id
      JOIN users owner ON owner.id = s.owner_id
      WHERE v.id = ${input.variantId} AND v.status = 'active' AND p.status = 'active' AND s.is_public
        AND (owner.seller_approval_status = 'approved' OR owner.role = 'admin') AND s.owner_id <> ${actor.id} AND v.price > 0
    ), cart AS (
      INSERT INTO carts(id, buyer_id) SELECT ${id}, ${actor.id} WHERE EXISTS (SELECT 1 FROM eligible)
      ON CONFLICT (buyer_id) DO UPDATE SET updated_at = clock_timestamp()
      RETURNING id
    ), changed AS (
      INSERT INTO cart_items(cart_id, variant_id, quantity)
      SELECT cart.id, eligible.id, ${input.quantity} FROM cart, eligible
      ON CONFLICT (cart_id, variant_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = clock_timestamp()
      RETURNING cart_id
    ) SELECT cart_id AS "cartId" FROM changed
  `);
  return result[0] ? { cartId: result[0].cartId } : { error: "not_found" };
}

export async function removeBuyerCartItem(actor: Actor, variantId: string) {
  if (!canBuy(actor)) return { error: "forbidden" };
  const result = await rows<{ variantId: string }>(sql`
    DELETE FROM cart_items ci USING carts c
    WHERE ci.cart_id = c.id AND c.buyer_id = ${actor.id} AND ci.variant_id = ${variantId}
    RETURNING ci.variant_id AS "variantId"
  `);
  return result[0] ? { variantId: result[0].variantId } : { error: "not_found" };
}
