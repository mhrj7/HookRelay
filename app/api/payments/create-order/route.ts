import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { listings, orders } from "../../../../db/schema";
import { requireUser } from "../../../../lib/auth";
import { actorFor, ensureUser, routeError } from "../../../../lib/marketplace";
import { canBuy } from "../../../../lib/authorization";
import { paymentProvider } from "../../../../lib/payment-provider";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: "Sign in to pay." }, { status: 401 });
    const { marketplaceOrderId } = await request.json() as { marketplaceOrderId?: string };
    if (!marketplaceOrderId) return Response.json({ error: "Order is required." }, { status: 400 });
    const db = getDb();
    if (!canBuy(await actorFor(db, identity.clerkId))) return Response.json({ error: "This account cannot pay for buyer orders." }, { status: 403 });
    const user = await ensureUser(db, identity.clerkId);
    const [record] = await db.select({ order: orders, price: listings.price, title: listings.title }).from(orders).innerJoin(listings, eq(orders.listingId, listings.id)).where(and(eq(orders.id, marketplaceOrderId), eq(orders.buyerId, user.id))).limit(1);
    if (!record) return Response.json({ error: "Order not found." }, { status: 404 });
    if (record.order.status !== "accepted") return Response.json({ error: "The seller must accept this request before payment." }, { status: 400 });
    if (record.order.paymentStatus === "paid") return Response.json({ error: "This order is already paid." }, { status: 400 });

    const provider = paymentProvider("razorpay_test");
    if (!provider) return Response.json({ error: "Razorpay test mode is not configured." }, { status: 503 });
    const checkout = await provider.createCheckout({
      intentId: record.order.id,
      amount: record.price,
      currency: "INR",
      receipt: record.order.id,
      metadata: { marketplace_order_id: record.order.id, environment: "test" },
    });
    if (!checkout.publicKeyId) return Response.json({ error: "Razorpay public test key is unavailable." }, { status: 503 });
    await db.update(orders).set({ razorpayOrderId: checkout.providerOrderId, paymentMethod: "razorpay_test", updatedAt: new Date().toISOString() }).where(eq(orders.id, record.order.id));
    return Response.json({ keyId: checkout.publicKeyId, razorpayOrderId: checkout.providerOrderId, amount: checkout.amount, currency: checkout.currency, title: record.title });
  } catch (error) {
    return routeError(error);
  }
}
