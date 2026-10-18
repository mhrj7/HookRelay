import { sql } from "drizzle-orm";
import { getDb } from "../db";
import type { Actor } from "./authorization";
import { paymentProvider } from "./payment-provider";

export function refundInput(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.key !== "string" || !/^[\w-]{16,80}$/.test(input.key) || typeof input.reason !== "string") return null;
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 240 || Object.keys(input).some(key => !["key", "reason"].includes(key))) return null;
  return { key: input.key, reason };
}

type BeginOutcome = {
  refundId?: string;
  paymentIntentId?: string;
  providerPaymentId?: string;
  provider?: string;
  amount?: number;
  currency?: string;
  reason?: string;
  status?: string;
  providerRefundId?: string;
  completedAt?: string;
  created?: boolean;
  replayed?: boolean;
  error?: string;
};

export type RefundOutcome = BeginOutcome & { outboxEventId?: string };

function firstOutcome<T>(result: unknown) {
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{ outcome: T }>;
  return rows[0].outcome;
}

export async function refundOrder(actor: Actor, orderId: string, input: NonNullable<ReturnType<typeof refundInput>>): Promise<RefundOutcome> {
  if (actor.role !== "admin") return { error: "forbidden" };
  const db = getDb();
  const begin = firstOutcome<BeginOutcome>(await db.execute(sql`
    SELECT begin_order_refund(${crypto.randomUUID()}, ${orderId}, ${actor.id}, ${input.key}, ${input.reason}) AS outcome
  `));
  if (begin.error || begin.status === "succeeded") return begin;
  if (!begin.refundId || !begin.paymentIntentId || !begin.providerPaymentId || !begin.provider || !begin.amount || !begin.currency || !begin.reason) return { error: "invalid" };
  const provider = paymentProvider(begin.provider);
  if (!provider) return { error: "unsupported_provider" };
  try {
    const result = await provider.refund({ providerPaymentId: begin.providerPaymentId, amount: begin.amount, currency: begin.currency, idempotencyKey: input.key, reason: begin.reason });
    const completed = firstOutcome<RefundOutcome>(await db.execute(sql`
      SELECT complete_order_refund(
        ${begin.refundId}, ${actor.id}, ${result.providerRefundId}, ${JSON.stringify(result.raw)}, ${crypto.randomUUID()}, ${crypto.randomUUID()}
      ) AS outcome
    `));
    return { ...completed, providerPaymentId: begin.providerPaymentId };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Provider refund failed";
    await db.execute(sql`SELECT fail_order_refund(${begin.refundId}, ${actor.id}, ${message}, ${crypto.randomUUID()})`);
    return { error: "provider_failure" };
  }
}
