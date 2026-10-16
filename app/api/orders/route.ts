import { desc, eq, or } from "drizzle-orm";
import { getDb } from "../../../db";
import { listings, orders, sellerPickupProfiles, shipmentEvents, shipments } from "../../../db/schema";
import { requireUser } from "../../../lib/auth";
import { actorFor, ensureUser, routeError } from "../../../lib/marketplace";
import { canBuy, sellerAccountId } from "../../../lib/authorization";
import { dispatchOrderNotification, recipientFor } from "../../../lib/notification-dispatch";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: "Sign in to view orders." }, { status: 401 });
    const db = getDb();
    if (!canBuy(await actorFor(db, identity.clerkId))) return Response.json({ error: "This account cannot create buyer orders." }, { status: 403 });
    const user = await ensureUser(db, identity.clerkId);
    const actor = await actorFor(db, identity.clerkId);
    const sellerId = sellerAccountId(actor);
    const [pickupProfile] = sellerId ? await db.select().from(sellerPickupProfiles).where(eq(sellerPickupProfiles.sellerId, sellerId)).limit(1) : [];
    const scope = actor.role === "admin" ? undefined : or(eq(orders.buyerId, user.id), ...(sellerId ? [eq(orders.sellerId, sellerId)] : []));
    const base = db.select({ order: orders, listingTitle: listings.title, listingPrice: listings.price, listingCity: listings.city, shipment: shipments }).from(orders).innerJoin(listings, eq(orders.listingId, listings.id)).leftJoin(shipments, eq(shipments.orderId, orders.id));
    const rows = scope ? await base.where(scope).orderBy(desc(orders.createdAt)) : await base.orderBy(desc(orders.createdAt));
    const response = await Promise.all(rows.map(async (row) => ({
      ...row,
      role: row.order.buyerId === user.id ? "buyer" : "seller",
      deliveryConfigured: Boolean(row.order.shippingName && row.order.shippingEmail && row.order.shippingPhone && row.order.shippingAddress && row.order.shippingCity && row.order.shippingState && row.order.shippingPincode),
      pickupConfigured: row.order.sellerId === sellerId && Boolean(pickupProfile),
      events: row.shipment ? await db.select().from(shipmentEvents).where(eq(shipmentEvents.shipmentId, row.shipment.id)).orderBy(desc(shipmentEvents.occurredAt)) : [],
    })));
    return Response.json({ orders: response });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: "Sign in to request pickup." }, { status: 401 });
    const { listingId, paymentMethod } = await request.json() as { listingId?: string; paymentMethod?: string };
    if (!listingId) return Response.json({ error: "Listing is required." }, { status: 400 });
    const db = getDb();
    const buyer = await ensureUser(db, identity.clerkId);
    const [listing] = await db.select().from(listings).where(eq(listings.id, listingId)).limit(1);
    if (!listing || listing.status !== "active") return Response.json({ error: "Listing is no longer available." }, { status: 404 });
    if (listing.sellerId === buyer.id) return Response.json({ error: "You cannot request your own listing." }, { status: 400 });
    const order = { id: crypto.randomUUID(), listingId, buyerId: buyer.id, sellerId: listing.sellerId, paymentMethod: paymentMethod === "upi_on_pickup" ? "upi_on_pickup" : "cash_on_pickup", status: "requested", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await db.insert(orders).values(order).onConflictDoNothing();
    const seller = await recipientFor(db, listing.sellerId);
    await dispatchOrderNotification(db, { eventKey: `order:${order.id}:requested:seller`, eventType: "order.requested", recipientId: seller.id, recipientClerkId: seller.clerkId, title: "New order request", body: `A buyer requested ${listing.title}. Review the request in Orders.` });
    return Response.json({ order }, { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}
