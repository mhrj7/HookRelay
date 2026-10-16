import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { notifications } from "../../../db/schema";
import { requireUser } from "../../../lib/auth";
import { ensureUser, routeError } from "../../../lib/marketplace";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: "Sign in to view notifications." }, { status: 401 });
    const db = getDb();
    const user = await ensureUser(db, identity.clerkId);
    const rows = await db.select().from(notifications).where(eq(notifications.recipientId, user.id)).orderBy(desc(notifications.createdAt));
    return Response.json({ notifications: rows.filter((notification) => notification.channel === "in_app") }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return routeError(error);
  }
}
