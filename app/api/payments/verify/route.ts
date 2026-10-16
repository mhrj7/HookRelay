import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { orders } from "../../../../db/schema";
import { requireUser } from "../../../../lib/auth";
import { actorFor, ensureUser, routeError } from "../../../../lib/marketplace";
import { canBuy } from "../../../../lib/authorization";
import { paymentProvider } from "../../../../lib/payment-provider";
import { dispatchOrderNotification, recipientFor } from "../../../../lib/notification-dispatch";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: "Sign in to verify payment." }, { status: 401 });
    const { marketplaceOrderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = await request.json() as Record<string, string | undefined>;
    if (!marketplaceOrderId || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) return Response.json({ error: "Payment response is incomplete." }, { status: 400 });
    const db = getDb();
    if (!canBuy(await actorFor(db, identity.clerkId))) return Response.json({ error: "This account cannot verify buyer payments." }, { status: 403 });
    const user = await ensureUser(db, identity.clerkId);
    const [order] = await db.select().from(orders).where(and(eq(orders.id, marketplaceOrderId), eq(orders.buyerId, user.id))).limit(1);
    if (!order || order.razorpayOrderId !== razorpayOrderId) return Response.json({ error: "Payment order does not match." }, { status: 400 });
    const provider = paymentProvider("razorpay_test");
    if (!provider) return Response.json({ error: "Razorpay test mode is not configured." }, { status: 503 });
    const verification = await provider.verifyPayment({ providerOrderId: razorpayOrderId, providerPaymentId: razorpayPaymentId, signature: razorpaySignature });
    if (!verification.verified) return Response.json({ error: "Payment signature could not be verified." }, { status: 400 });
    const [updated] = await db.update(orders).set({ paymentStatus: "paid", razorpayPaymentId, updatedAt: new Date().toISOString() }).where(eq(orders.id, order.id)).returning();
    const seller = await recipientFor(db, order.sellerId);
    await dispatchOrderNotification(db, { eventKey: `order:${order.id}:payment_paid:seller`, eventType: "order.payment_paid", recipientId: seller.id, recipientClerkId: seller.clerkId, title: "Test payment verified", body: "The buyer’s test payment was verified. You can now create the shipment after delivery details are present." });
    return Response.json({ order: updated });
  } catch (error) {
    return routeError(error);
  }
}
