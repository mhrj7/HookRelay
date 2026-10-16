import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { disputes } from "../../../../../db/schema";
import { requireUser } from "../../../../../lib/auth";
import { canAccessAdminOperations } from "../../../../../lib/authorization";
import { parseDisputeDecision, type DisputeStatus } from "../../../../../lib/dispute-service";
import { actorFor, routeError } from "../../../../../lib/marketplace";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: "Administrator access is required." }, { status: 403 });
    const db = getDb();
    const actor = await actorFor(db, identity.clerkId);
    if (!canAccessAdminOperations(actor)) return Response.json({ error: "Administrator access is required." }, { status: 403 });
    const { id } = await params;
    const [current] = await db.select().from(disputes).where(eq(disputes.id, id)).limit(1);
    if (!current) return Response.json({ error: "Dispute not found." }, { status: 404 });
    const decision = parseDisputeDecision(await request.json(), current.status as DisputeStatus);
    if (!decision) return Response.json({ error: "This dispute transition is not allowed. Final decisions require a 5–1,000 character resolution." }, { status: 409 });
    const now = new Date();
    const [dispute] = await db.update(disputes).set(decision.status === "under_review" ? { status: decision.status, updatedAt: now } : { status: decision.status, resolution: decision.resolution, resolvedBy: actor.id, resolvedAt: now, updatedAt: now }).where(eq(disputes.id, id)).returning();
    return Response.json({ dispute });
  } catch (error) {
    return routeError(error);
  }
}
