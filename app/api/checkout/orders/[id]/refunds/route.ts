import { getDb } from "../../../../../../db";
import { requireUser } from "../../../../../../lib/auth";
import { actorFor, routeError } from "../../../../../../lib/marketplace";
import { refundInput, refundOrder } from "../../../../../../lib/refund-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: "Sign in to refund an order." }, { status: 401 });
    const input = refundInput(await request.json().catch(() => null));
    if (!input) return Response.json({ error: "Provide an idempotency key and a reason between 5 and 240 characters." }, { status: 400 });
    const { id } = await params;
    if (!/^[\w-]{1,100}$/.test(id)) return Response.json({ error: "Order not found." }, { status: 404 });
    const outcome = await refundOrder(await actorFor(getDb(), identity.clerkId), id, input);
    const messages: Record<string, string> = {
      forbidden: "Only an administrator can issue refunds.",
      not_found: "Order not found.",
      invalid_state: "Only a paid, unrefunded order can be refunded.",
      key_conflict: "This idempotency key belongs to another refund.",
      refund_exists: "This order already has a refund under a different key.",
      unsupported_provider: "This payment provider cannot issue refunds.",
      provider_failure: "The provider rejected the refund; the order was not changed.",
      invalid: "Refund could not be started.",
    };
    if (outcome.error) {
      const status = outcome.error === "forbidden" ? 403 : outcome.error === "not_found" ? 404 : outcome.error === "provider_failure" ? 502 : 409;
      return Response.json({ error: messages[outcome.error] ?? "Refund could not be completed." }, { status });
    }
    return Response.json({ refund: outcome }, { status: outcome.replayed ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routeError(error);
  }
}
