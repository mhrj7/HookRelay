import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { commerceOrderItems } from "../../../../db/schema";
import { requireUser } from "../../../../lib/auth";
import { checkoutInput, createCartCheckout } from "../../../../lib/checkout-service";
import { actorFor, routeError } from "../../../../lib/marketplace";
import { dispatchOrderNotification, recipientFor } from "../../../../lib/notification-dispatch";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: "Sign in to create an order." }, { status: 401 });
    const input = checkoutInput(await request.json().catch(() => null));
    if (!input) return Response.json({ error: "Provide one unique active reservation for every cart SKU." }, { status: 400 });
    const db = getDb();
    const outcome = await createCartCheckout(await actorFor(db, identity.clerkId), input);
    const messages: Record<string, string> = {
      forbidden: "This account cannot create buyer orders.", cart_empty: "Your cart is empty.",
      reservation_mismatch: "Cart prices, quantities, or reservations changed. Reserve every current cart SKU again.",
      reservation_used: "One of these reservations already created an order.", conflict: "Checkout conflicted with another request. Refresh and try again.",
      key_conflict: "This idempotency key was already used for a different checkout.", invalid: "Checkout reservations or idempotency key are invalid.",
    };
    if (outcome.error) return Response.json({ error: messages[outcome.error] ?? "Checkout could not be created." }, { status: outcome.error === "forbidden" ? 403 : outcome.error === "cart_empty" ? 400 : 409 });
    if (outcome.orderId) {
      const items = await db.select({ sellerId: commerceOrderItems.sellerId }).from(commerceOrderItems).where(eq(commerceOrderItems.orderId, outcome.orderId));
      for (const sellerId of new Set(items.map((item) => item.sellerId))) {
        const seller = await recipientFor(db, sellerId);
        await dispatchOrderNotification(db, {
          eventKey: `commerce-order:${outcome.orderId}:created:seller:${seller.id}`,
          eventType: "order.created",
          recipientId: seller.id,
          recipientClerkId: seller.clerkId,
          title: "New checkout order",
          body: `A buyer created a checkout order for ₹${outcome.total?.toLocaleString("en-IN") ?? "0"}. Review the order before fulfilling it.`,
        });
      }
    }
    return Response.json({ order: outcome }, { status: outcome.replayed ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routeError(error);
  }
}
