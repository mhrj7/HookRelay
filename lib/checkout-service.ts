import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { canBuy, type Actor } from "./authorization";

export function checkoutInput(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.reservationIds) || input.reservationIds.length < 1 || input.reservationIds.length > 50 ||
    input.reservationIds.some(id => typeof id !== "string" || !/^[\w-]{1,100}$/.test(id)) ||
    new Set(input.reservationIds).size !== input.reservationIds.length || Object.keys(input).some(key => key !== "reservationIds")) return null;
  return { reservationIds: input.reservationIds as string[] };
}

export type CheckoutOutcome = { orderId?: string; paymentIntentId?: string; outboxEventId?: string; total?: number; currency?: string; status?: string; error?: string };

export async function createCartCheckout(actor: Actor, input: NonNullable<ReturnType<typeof checkoutInput>>): Promise<CheckoutOutcome> {
  if (!canBuy(actor)) return { error: "forbidden" };
  const result = await getDb().execute(sql`
    SELECT create_cart_checkout(
      ${crypto.randomUUID()}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, ${actor.id}, ${JSON.stringify(input.reservationIds)}::jsonb
    ) AS outcome
  `);
  const rows = (Array.isArray(result) ? result : result.rows) as Array<{ outcome: CheckoutOutcome }>;
  return rows[0].outcome;
}
