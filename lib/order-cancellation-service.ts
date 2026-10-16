import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { canBuy, type Actor } from "./authorization";

export type CancellationOutcome = {
  orderId?: string;
  status?: string;
  cancelledAt?: string;
  outboxEventId?: string;
  releasedQuantity?: number;
  replayed?: boolean;
  error?: "forbidden" | "not_found" | "invalid_state";
};

export async function cancelCommerceOrder(actor: Actor, orderId: string): Promise<CancellationOutcome> {
  if (!canBuy(actor)) return { error: "forbidden" };
  const result = await getDb().execute(sql`
    SELECT cancel_commerce_order(${orderId}, ${actor.id}, ${crypto.randomUUID()}) AS outcome
  `);
  const rows = (Array.isArray(result) ? result : result.rows) as Array<{ outcome: CancellationOutcome }>;
  return rows[0].outcome;
}
