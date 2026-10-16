import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { commerceOrders, disputes } from "../../../../db/schema";
import { requireUser } from "../../../../lib/auth";
import { canAccessAdminOperations } from "../../../../lib/authorization";
import { parseDisputeCreate } from "../../../../lib/dispute-service";
import { actorFor, routeError } from "../../../../lib/marketplace";

export const dynamic = "force-dynamic";

async function requireAdmin(request: Request) {
  const identity = await requireUser(request);
  if (!identity) return null;
  const db = getDb();
  const actor = await actorFor(db, identity.clerkId);
  return canAccessAdminOperations(actor) ? { db, actor } : null;
}

export async function GET(request: Request) {
  try {
    const result = await requireAdmin(request);
    if (!result) return Response.json({ error: "Administrator access is required." }, { status: 403 });
    const [rows, orders] = await Promise.all([
      result.db.select({ dispute: disputes, orderTotal: commerceOrders.total, orderStatus: commerceOrders.status, orderCreatedAt: commerceOrders.createdAt })
        .from(disputes).innerJoin(commerceOrders, eq(disputes.orderId, commerceOrders.id)).orderBy(desc(disputes.updatedAt)).limit(50),
      result.db.select({ id: commerceOrders.id, total: commerceOrders.total, status: commerceOrders.status, createdAt: commerceOrders.createdAt })
        .from(commerceOrders).orderBy(desc(commerceOrders.createdAt)).limit(50),
    ]);
    return Response.json({ disputes: rows.map((row) => ({ ...row.dispute, orderTotal: row.orderTotal, orderStatus: row.orderStatus, orderCreatedAt: row.orderCreatedAt })), orders });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  try {
    const result = await requireAdmin(request);
    if (!result) return Response.json({ error: "Administrator access is required." }, { status: 403 });
    const input = parseDisputeCreate(await request.json());
    if (!input) return Response.json({ error: "Choose a checkout order and provide a 5–500 character reason." }, { status: 400 });
    const [order] = await result.db.select({ id: commerceOrders.id }).from(commerceOrders).where(eq(commerceOrders.id, input.orderId)).limit(1);
    if (!order) return Response.json({ error: "Checkout order not found." }, { status: 404 });
    const [existing] = await result.db.select({ id: disputes.id }).from(disputes).where(eq(disputes.orderId, input.orderId)).limit(1);
    if (existing) return Response.json({ error: "A dispute already exists for this order." }, { status: 409 });
    const now = new Date();
    const dispute = { id: crypto.randomUUID(), orderId: input.orderId, openedBy: result.actor.id, status: "open", reason: input.reason, createdAt: now, updatedAt: now };
    await result.db.insert(disputes).values(dispute);
    return Response.json({ dispute }, { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}
