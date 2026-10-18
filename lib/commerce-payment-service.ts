import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { canBuy, type Actor } from "./authorization";
import { paymentProvider } from "./payment-provider";

type PaymentOutcome = {
  orderId?: string; paymentIntentId?: string; status?: string; provider?: string;
  providerOrderId?: string; amount?: number; currency?: string; outboxEventId?: string;
  replayed?: boolean; error?: string;
};

function firstOutcome<T>(result: unknown) {
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{ outcome: T }>;
  return rows[0].outcome;
}

export function paymentVerificationInput(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.providerOrderId !== "string" || input.providerOrderId.length > 100 ||
      typeof input.providerPaymentId !== "string" || input.providerPaymentId.length > 100 ||
      typeof input.signature !== "string" || input.signature.length > 256 ||
      Object.keys(input).some(key => !["providerOrderId", "providerPaymentId", "signature"].includes(key))) return null;
  return { providerOrderId: input.providerOrderId, providerPaymentId: input.providerPaymentId, signature: input.signature };
}

export async function startCommercePayment(actor: Actor, orderId: string, providerName = "razorpay_test") {
  if (!canBuy(actor)) return { error: "forbidden" };
  const provider = paymentProvider(providerName);
  if (!provider) return { error: "unsupported_provider" };
  const db = getDb();
  const begin = firstOutcome<PaymentOutcome>(await db.execute(sql`SELECT begin_commerce_payment(${orderId}, ${actor.id}, ${providerName}) AS outcome`));
  if (begin.error || begin.status === "succeeded") return begin;
  if (!begin.paymentIntentId || !begin.amount || !begin.currency) return { error: "invalid" };
  if (begin.providerOrderId) return { ...begin, publicKeyId: providerName === "razorpay_test" ? process.env.RAZORPAY_TEST_KEY_ID : undefined };
  const checkout = await provider.createCheckout({ intentId: begin.paymentIntentId, amount: begin.amount, currency: begin.currency, receipt: orderId, metadata: { commerce_order_id: orderId, payment_intent_id: begin.paymentIntentId, environment: "test" } });
  const stored = firstOutcome<PaymentOutcome>(await db.execute(sql`SELECT store_commerce_payment_order(${begin.paymentIntentId}, ${checkout.providerOrderId}, ${JSON.stringify(checkout.raw)}) AS outcome`));
  return { ...stored, publicKeyId: checkout.publicKeyId };
}

export async function verifyCommercePayment(actor: Actor, orderId: string, input: NonNullable<ReturnType<typeof paymentVerificationInput>>) {
  if (!canBuy(actor)) return { error: "forbidden" };
  const db = getDb();
  const lookup = await db.execute(sql`SELECT provider, amount, currency, provider_order_id AS "providerOrderId" FROM payment_intents WHERE order_id = ${orderId} AND order_id IN (SELECT id FROM commerce_orders WHERE buyer_id = ${actor.id})`);
  const rows = (Array.isArray(lookup) ? lookup : lookup.rows) as Array<{ provider: string; amount: number; currency: string; providerOrderId: string | null }>;
  const intent = rows[0];
  if (!intent) return { error: "not_found" };
  if (!intent.providerOrderId || intent.providerOrderId !== input.providerOrderId) return { error: "provider_conflict" };
  const provider = paymentProvider(intent.provider);
  if (!provider) return { error: "unsupported_provider" };
  const verification = await provider.verifyCapturedPayment({ ...input, amount: intent.amount, currency: intent.currency });
  if (!verification.verified) return { error: "verification_failed" };
  return firstOutcome<PaymentOutcome>(await db.execute(sql`SELECT capture_commerce_payment(${orderId}, ${actor.id}, ${input.providerOrderId}, ${input.providerPaymentId}, ${JSON.stringify(verification.raw)}, ${crypto.randomUUID()}) AS outcome`));
}
