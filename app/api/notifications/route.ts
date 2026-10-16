import { desc, inArray } from "drizzle-orm";
import { getDb } from "../../../db";
import { notifications } from "../../../db/schema";
import { requireUser } from "../../../lib/auth";
import { actorFor, routeError } from "../../../lib/marketplace";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: "Sign in to view notifications." }, { status: 401 });
    const db = getDb();
    const actor = await actorFor(db, identity.clerkId);
    // Seller staff work on behalf of one approved seller account, so they need the
    // owner-facing operational alerts as well as any alerts addressed directly to them.
    const recipientIds = actor.staffForSellerId ? [actor.id, actor.staffForSellerId] : [actor.id];
    const rows = await db.select().from(notifications).where(inArray(notifications.recipientId, recipientIds)).orderBy(desc(notifications.createdAt));
    return Response.json({ notifications: rows.filter((notification) => notification.channel === "in_app") }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routeError(error);
  }
}
