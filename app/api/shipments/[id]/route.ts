import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { orders, shipmentEvents, shipments } from "../../../../db/schema";
import { requireUser } from "../../../../lib/auth";
import { advanceShipmentRecord } from "../../../../lib/shipment-service";
import { shippingProvider } from "../../../../lib/shipping-provider";
import { actorFor, routeError } from "../../../../lib/marketplace";
import { canManageSeller, sellerAccountId } from "../../../../lib/authorization";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: "Sign in to update a shipment." }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const seller = await actorFor(db, identity.clerkId);
    const sellerId = sellerAccountId(seller);
    if (!sellerId || !canManageSeller(seller, sellerId)) return Response.json({ error: "Only seller accounts can update shipments." }, { status: 403 });
    const [record] = await db.select({ shipment: shipments, order: orders }).from(shipments).innerJoin(orders, eq(shipments.orderId, orders.id)).where(and(eq(shipments.id, id), eq(orders.sellerId, sellerId))).limit(1);
    if (!record) return Response.json({ error: "Shipment not found." }, { status: 404 });
    const now = new Date().toISOString();
    const next = await advanceShipmentRecord(record.shipment, now, shippingProvider());
    if (!next) return Response.json({ error: "This shipment is already complete." }, { status: 409 });
    const [shipment] = await db.update(shipments).set({ status: next.shipment.status, updatedAt: now }).where(eq(shipments.id, id)).returning();
    await db.insert(shipmentEvents).values({ id: crypto.randomUUID(), shipmentId: id, ...next.event });
    if (next.shipment.status === "delivered") await db.update(orders).set({ status: "completed", updatedAt: now }).where(eq(orders.id, record.order.id));
    return Response.json({ shipment, next: next.shipment.status });
  } catch (error) {
    return routeError(error);
  }
}
