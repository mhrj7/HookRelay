import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import { notifications } from "../../../../db/schema";
import { requireUser } from "../../../../lib/auth";
import { actorFor, routeError } from "../../../../lib/marketplace";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: "Sign in to manage notifications." }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const actor = await actorFor(db, identity.clerkId);
    const recipientIds = actor.staffForSellerId ? [actor.id, actor.staffForSellerId] : [actor.id];
    const [notification] = await db.update(notifications).set({ readAt: new Date().toISOString() }).where(and(eq(notifications.id, id), inArray(notifications.recipientId, recipientIds), eq(notifications.channel, "in_app"))).returning();
    if (!notification) return Response.json({ error: "Notification not found." }, { status: 404 });
    return Response.json({ notification });
  } catch (error) {
    return routeError(error);
  }
}
