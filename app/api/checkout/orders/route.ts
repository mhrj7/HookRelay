import { getDb } from "../../../../db";
import { requireUser } from "../../../../lib/auth";
import { checkoutInput, createCartCheckout } from "../../../../lib/checkout-service";
import { actorFor, routeError } from "../../../../lib/marketplace";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: "Sign in to create an order." }, { status: 401 });
    const input = checkoutInput(await request.json().catch(() => null));
    if (!input) return Response.json({ error: "Provide one unique active reservation for every cart SKU." }, { status: 400 });
    const outcome = await createCartCheckout(await actorFor(getDb(), identity.clerkId), input);
    const messages: Record<string, string> = {
      forbidden: "This account cannot create buyer orders.", cart_empty: "Your cart is empty.",
      reservation_mismatch: "Cart prices, quantities, or reservations changed. Reserve every current cart SKU again.",
      reservation_used: "One of these reservations already created an order.", conflict: "Checkout conflicted with another request. Refresh and try again.",
      invalid: "Checkout reservations are invalid.",
    };
    if (outcome.error) return Response.json({ error: messages[outcome.error] ?? "Checkout could not be created." }, { status: outcome.error === "forbidden" ? 403 : outcome.error === "cart_empty" ? 400 : 409 });
    return Response.json({ order: outcome }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routeError(error);
  }
}
