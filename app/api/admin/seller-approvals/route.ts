import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { sellerApprovalAudits, users } from "../../../../db/schema";
import { requireUser } from "../../../../lib/auth";
import { actorFor, routeError } from "../../../../lib/marketplace";
import { canApproveSellers } from "../../../../lib/authorization";
import { decideSellerApproval } from "../../../../lib/audit-service";

export const dynamic = "force-dynamic";

async function requireAdmin(request: Request) {
  const identity = await requireUser(request);
  if (!identity) return null;
  const db = getDb();
  const actor = await actorFor(db, identity.clerkId);
  return canApproveSellers(actor) ? { db, actor } : null;
}

export async function GET(request: Request) {
  try {
    const result = await requireAdmin(request);
    if (!result) return Response.json({ error: "Administrator access is required." }, { status: 403 });
    const sellers = await result.db.select({ id: users.id, displayName: users.displayName, status: users.sellerApprovalStatus, requestedAt: users.sellerApprovalRequestedAt }).from(users).where(eq(users.sellerApprovalStatus, "pending")).orderBy(desc(users.sellerApprovalRequestedAt));
    const audits = await result.db.select().from(sellerApprovalAudits).orderBy(desc(sellerApprovalAudits.createdAt)).limit(30);
    return Response.json({ sellers, audits });
  } catch (error) { return routeError(error); }
}

export async function PATCH(request: Request) {
  try {
    const result = await requireAdmin(request);
    if (!result) return Response.json({ error: "Administrator access is required." }, { status: 403 });
    const { sellerId, decision } = await request.json() as { sellerId?: number; decision?: "approved" | "rejected" };
    if (!Number.isInteger(sellerId) || (decision !== "approved" && decision !== "rejected")) return Response.json({ error: "Choose a seller and an approval decision." }, { status: 400 });
    const seller = await decideSellerApproval({ actor: result.actor, sellerId: sellerId!, decision });
    if (!seller) return Response.json({ error: "This seller does not have a pending approval request." }, { status: 409 });
    return Response.json({ seller: { id: seller.sellerId, status: seller.status } });
  } catch (error) { return routeError(error); }
}
