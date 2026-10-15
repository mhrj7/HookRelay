import { getDb } from "../../../db";
import { requireUser } from "../../../lib/auth";
import { actorFor, routeError } from "../../../lib/marketplace";
import { buyerCart, cartItemInput, removeBuyerCartItem, setBuyerCartItem } from "../../../lib/cart-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: "Sign in to view your cart." }, { status: 401 });
    const cart = await buyerCart(await actorFor(getDb(), identity.clerkId));
    if (!cart) return Response.json({ error: "This account cannot use a buyer cart." }, { status: 403 });
    return Response.json({ cart }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: "Sign in to add items to your cart." }, { status: 401 });
    const input = cartItemInput(await request.json().catch(() => null));
    if (!input) return Response.json({ error: "Choose an active SKU and a whole-number quantity from 1 to 20." }, { status: 400 });
    const actor = await actorFor(getDb(), identity.clerkId);
    const outcome = await setBuyerCartItem(actor, input);
    if (outcome.error === "forbidden") return Response.json({ error: "This account cannot use a buyer cart." }, { status: 403 });
    if (outcome.error) return Response.json({ error: "That SKU is unavailable or belongs to your own store." }, { status: 404 });
    return Response.json({ cart: await buyerCart(actor) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routeError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: "Sign in to update your cart." }, { status: 401 });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.variantId !== "string" || !/^[\w-]{1,100}$/.test(body.variantId) || Object.keys(body).some(key => key !== "variantId")) {
      return Response.json({ error: "A valid SKU selection is required." }, { status: 400 });
    }
    const actor = await actorFor(getDb(), identity.clerkId);
    const outcome = await removeBuyerCartItem(actor, body.variantId);
    if (outcome.error === "forbidden") return Response.json({ error: "This account cannot use a buyer cart." }, { status: 403 });
    if (outcome.error) return Response.json({ error: "That item is not in your cart." }, { status: 404 });
    return Response.json({ cart: await buyerCart(actor) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routeError(error);
  }
}
