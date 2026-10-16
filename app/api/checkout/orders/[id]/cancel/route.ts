import { getDb } from "../../../../../../db";
import { requireUser } from "../../../../../../lib/auth";
import { actorFor, routeError } from "../../../../../../lib/marketplace";
import { cancelCommerceOrder } from "../../../../../../lib/order-cancellation-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: "Sign in to cancel an order." }, { status: 401 });
    const { id } = await params;
    if (!/^[\w-]{1,100}$/.test(id)) return Response.json({ error: "Order not found." }, { status: 404 });
    const outcome = await cancelCommerceOrder(await actorFor(getDb(), identity.clerkId), id);
    if (outcome.error === "forbidden") return Response.json({ error: "This account cannot cancel buyer orders." }, { status: 403 });
    if (outcome.error === "not_found") return Response.json({ error: "Order not found." }, { status: 404 });
    if (outcome.error === "invalid_state") return Response.json({ error: "Only an unpaid order awaiting payment can be cancelled." }, { status: 409 });
    return Response.json({ cancellation: outcome }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routeError(error);
  }
}
