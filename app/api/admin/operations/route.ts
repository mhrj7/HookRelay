import { count, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { categories, commerceOrders, listings, orders, products, stores, users } from "../../../../db/schema";
import { requireUser } from "../../../../lib/auth";
import { canAccessAdminOperations } from "../../../../lib/authorization";
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

    const [pendingSellers, catalogProducts, marketplaceOrders, checkoutOrders, metricRows] = await Promise.all([
      result.db.select({ id: users.id, displayName: users.displayName, status: users.sellerApprovalStatus, requestedAt: users.sellerApprovalRequestedAt })
        .from(users).where(eq(users.sellerApprovalStatus, "pending")).orderBy(desc(users.sellerApprovalRequestedAt)).limit(20),
      result.db.select({ id: products.id, title: products.title, status: products.status, price: products.price, createdAt: products.createdAt, storeName: stores.name, categoryName: categories.name })
        .from(products).innerJoin(stores, eq(products.storeId, stores.id)).innerJoin(categories, eq(products.categoryId, categories.id))
        .orderBy(desc(products.createdAt)).limit(20),
      result.db.select({ id: orders.id, status: orders.status, paymentStatus: orders.paymentStatus, total: listings.price, createdAt: orders.createdAt, reference: listings.title })
        .from(orders).innerJoin(listings, eq(orders.listingId, listings.id)).orderBy(desc(orders.createdAt)).limit(20),
      result.db.select({ id: commerceOrders.id, status: commerceOrders.status, total: commerceOrders.total, createdAt: commerceOrders.createdAt })
        .from(commerceOrders).orderBy(desc(commerceOrders.createdAt)).limit(20),
      Promise.all([
        result.db.select({ value: count() }).from(users),
        result.db.select({ value: count() }).from(stores),
        result.db.select({ value: count() }).from(products),
        result.db.select({ value: count() }).from(listings),
        result.db.select({ value: count() }).from(orders),
        result.db.select({ value: count() }).from(commerceOrders),
      ]),
    ]);

    const operationalOrders = [
      ...marketplaceOrders.map((order) => ({ ...order, kind: "Marketplace" as const })),
      ...checkoutOrders.map((order) => ({ ...order, paymentStatus: "checkout", reference: "Cart checkout", kind: "Checkout" as const })),
    ].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()).slice(0, 20);

    return Response.json({
      metrics: {
        users: metricRows[0][0]?.value ?? 0,
        stores: metricRows[1][0]?.value ?? 0,
        catalogProducts: metricRows[2][0]?.value ?? 0,
        marketplaceListings: metricRows[3][0]?.value ?? 0,
        marketplaceOrders: metricRows[4][0]?.value ?? 0,
        checkoutOrders: metricRows[5][0]?.value ?? 0,
      },
      sellers: pendingSellers,
      products: catalogProducts,
      orders: operationalOrders,
    });
  } catch (error) {
    return routeError(error);
  }
}
