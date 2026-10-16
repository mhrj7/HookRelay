import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { products } from "../../../../../db/schema";
import { requireUser } from "../../../../../lib/auth";
import { canAccessAdminOperations } from "../../../../../lib/authorization";
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

    const { status } = await request.json() as { status?: string };
    if (status !== "active" && status !== "archived") return Response.json({ error: "Choose active or archived status." }, { status: 400 });
    const { id } = await params;
    const [product] = await db.update(products).set({ status, updatedAt: new Date().toISOString() }).where(eq(products.id, id)).returning();
    if (!product) return Response.json({ error: "Product not found." }, { status: 404 });
    return Response.json({ product });
  } catch (error) {
    return routeError(error);
  }
}
