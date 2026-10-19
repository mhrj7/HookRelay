import { getDb } from "../../../../db";
import { latestAuditEvents } from "../../../../lib/audit-service";
import { requireUser } from "../../../../lib/auth";
import { canAccessAdminOperations } from "../../../../lib/authorization";
import { actorFor, routeError } from "../../../../lib/marketplace";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: "Administrator access is required." }, { status: 403 });
    const actor = await actorFor(getDb(), identity.clerkId);
    if (!canAccessAdminOperations(actor)) return Response.json({ error: "Administrator access is required." }, { status: 403 });
    const requestedLimit = Number(new URL(request.url).searchParams.get("limit") ?? "100");
    const limit = Number.isInteger(requestedLimit) ? requestedLimit : 100;
    return Response.json({ events: await latestAuditEvents(limit) });
  } catch (error) {
    return routeError(error);
  }
}
