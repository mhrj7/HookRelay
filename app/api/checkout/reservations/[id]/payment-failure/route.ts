import { getDb } from "../../../../../../db";
import { requireUser } from "../../../../../../lib/auth";
import { actorFor, routeError } from "../../../../../../lib/marketplace";
import { buyerReservation, releaseAfterPaymentFailure } from "../../../../../../lib/reservation-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: "Sign in required." }, { status: 401 });
    const actor = await actorFor(getDb(), identity.clerkId);
    const id = (await params).id;
    const outcome = await releaseAfterPaymentFailure(actor, id);
    if (outcome.error === "forbidden") return Response.json({ error: "This account cannot release buyer checkout stock." }, { status: 403 });
    if (outcome.error === "not_found") return Response.json({ error: "Checkout not found." }, { status: 404 });
    const reservation = await buyerReservation(actor, id);
    return Response.json({ reservation }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routeError(error);
  }
}
