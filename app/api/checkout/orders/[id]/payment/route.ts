import { getDb } from "../../../../../../db";
import { requireUser } from "../../../../../../lib/auth";
import { actorFor, routeError } from "../../../../../../lib/marketplace";
import { paymentVerificationInput, startCommercePayment, verifyCommercePayment } from "../../../../../../lib/commerce-payment-service";

export const dynamic = "force-dynamic";

const messages: Record<string, string> = {
  forbidden: "This account cannot pay for buyer orders.", not_found: "Order not found.",
  invalid_state: "This order cannot accept a payment.", in_progress: "Payment setup is already in progress.",
  unsupported_provider: "Razorpay test mode is not configured.", provider_conflict: "Payment does not match this order.",
  verification_failed: "The payment was not captured or could not be verified.",
  reservation_expired: "Payment was captured after the stock hold expired. The order is in payment review and must not be fulfilled.",
};

function statusFor(error: string) {
  if (error === "forbidden") return 403;
  if (error === "not_found") return 404;
  if (error === "unsupported_provider") return 503;
  if (["invalid_state", "in_progress", "provider_conflict", "reservation_expired"].includes(error)) return 409;
  return 400;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: "Sign in to pay for this order." }, { status: 401 });
    const { id } = await params;
    const configuredProvider = process.env.COMMERCE_PAYMENT_PROVIDER === "internal_test" ? "internal_test" : "razorpay_test";
    const outcome = await startCommercePayment(await actorFor(getDb(), identity.clerkId), id, configuredProvider);
    if (outcome.error) return Response.json({ error: messages[outcome.error] ?? "Payment setup failed." }, { status: statusFor(outcome.error) });
    return Response.json({ payment: outcome }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return routeError(error); }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: "Sign in to verify this payment." }, { status: 401 });
    const input = paymentVerificationInput(await request.json().catch(() => null));
    if (!input) return Response.json({ error: "Payment response is incomplete." }, { status: 400 });
    const { id } = await params;
    const outcome = await verifyCommercePayment(await actorFor(getDb(), identity.clerkId), id, input);
    if (outcome.error) return Response.json({ error: messages[outcome.error] ?? "Payment verification failed.", payment: outcome }, { status: statusFor(outcome.error) });
    return Response.json({ payment: outcome }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return routeError(error); }
}
