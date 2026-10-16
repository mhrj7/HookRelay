import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  listings,
  orders,
  sellerPickupProfiles,
  shipmentEvents,
  shipments,
} from "../../../../../db/schema";
import { requireUser } from "../../../../../lib/auth";
import { createShipmentRecord } from "../../../../../lib/shipment-service";
import { shippingProvider } from "../../../../../lib/shipping-provider";
import { actorFor, routeError } from "../../../../../lib/marketplace";
import { canManageSeller, sellerAccountId } from "../../../../../lib/authorization";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    const identity = await requireUser(request);
    if (!identity)
      return Response.json(
        { error: "Sign in to create a shipment." },
        { status: 401 },
      );

    const { id: orderId } = await params;
    const db = getDb();
    const seller = await actorFor(db, identity.clerkId);
    const sellerId = sellerAccountId(seller);
    if (!sellerId || !canManageSeller(seller, sellerId)) return Response.json({ error: "Only seller accounts can create shipments." }, { status: 403 });
    const [record] = await db
      .select({ order: orders, listing: listings })
      .from(orders)
      .innerJoin(listings, eq(orders.listingId, listings.id))
      .where(and(eq(orders.id, orderId), eq(orders.sellerId, sellerId)))
      .limit(1);
    const order = record?.order;
    if (!order)
      return Response.json(
        { error: "Only the seller can create this shipment." },
        { status: 403 },
      );
    if (order.status !== "accepted" || order.paymentStatus !== "paid") {
      return Response.json(
        {
          error:
            "Accept and verify the test payment before creating a shipment.",
        },
        { status: 409 },
      );
    }
    if (
      !order.shippingName ||
      !order.shippingEmail ||
      !order.shippingPhone ||
      !order.shippingAddress ||
      !order.shippingCity ||
      !order.shippingState ||
      !order.shippingPincode
    ) {
      return Response.json(
        { error: "The buyer needs to add a delivery address before shipping." },
        { status: 409 },
      );
    }
    const [pickup] = await db
      .select()
      .from(sellerPickupProfiles)
      .where(eq(sellerPickupProfiles.sellerId, sellerId))
      .limit(1);
    if (!pickup)
      return Response.json(
        { error: "Add a pickup address in Shipping setup first." },
        { status: 409 },
      );
    const [existing] = await db
      .select()
      .from(shipments)
      .where(eq(shipments.orderId, orderId))
      .limit(1);
    if (existing) return Response.json({ shipment: existing, reused: true });

    const now = new Date().toISOString();
    const prepared = await createShipmentRecord(orderId, {
      orderId,
      recipient: {
        name: order.shippingName,
        email: order.shippingEmail,
        phone: order.shippingPhone,
        address: order.shippingAddress,
        city: order.shippingCity,
        state: order.shippingState,
        pincode: order.shippingPincode,
      },
      createdAt: now,
    }, shippingProvider());
    await db.insert(shipments).values(prepared.shipment);
    await db.insert(shipmentEvents).values({
      id: crypto.randomUUID(),
      shipmentId: prepared.shipment.id,
      ...prepared.event,
    });
    await db
      .update(orders)
      .set({ status: "ready_for_pickup", updatedAt: now })
      .where(eq(orders.id, orderId));
    return Response.json({ shipment: prepared.shipment }, { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}
