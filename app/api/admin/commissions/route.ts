import { desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../../../db';
import { commerceOrderItems, commerceOrders, refunds } from '../../../../db/schema';
import { requireUser } from '../../../../lib/auth';
import { canAccessAdminOperations } from '../../../../lib/authorization';
import { commissionReport, CommissionDataError } from '../../../../lib/commission-service';
import { actorFor, routeError } from '../../../../lib/marketplace';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: 'Administrator access is required.' }, { status: 403 });
    const db = getDb();
    if (!canAccessAdminOperations(await actorFor(db, identity.clerkId))) return Response.json({ error: 'Administrator access is required.' }, { status: 403 });
    const sources = await db.select({ orderId: commerceOrders.id, orderStatus: commerceOrders.status, orderTotal: commerceOrders.total, createdAt: commerceOrders.createdAt, variantId: commerceOrderItems.variantId, storeId: commerceOrderItems.storeId, quantity: commerceOrderItems.quantity, lineTotal: commerceOrderItems.lineTotal, commissionRateBps: commerceOrderItems.commissionRateBps, refundId: refunds.id, refundStatus: refunds.status, refundAmount: refunds.amount })
      .from(commerceOrders).leftJoin(commerceOrderItems, eq(commerceOrders.id, commerceOrderItems.orderId))
      .leftJoin(refunds, eq(commerceOrders.id, refunds.orderId)).where(inArray(commerceOrders.status, ['paid', 'refunded'])).orderBy(desc(commerceOrders.createdAt));
    const completeSources = sources.map(source => {
      if (source.variantId === null || source.storeId === null || source.quantity === null || source.lineTotal === null) throw new CommissionDataError('Settled order has no items');
      return { ...source, variantId: source.variantId, storeId: source.storeId, quantity: source.quantity, lineTotal: source.lineTotal };
    });
    return Response.json(commissionReport(completeSources), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof CommissionDataError) return Response.json({ error: 'Commission report requires reconciliation: an order item or refund has inconsistent or missing data.' }, { status: 409 });
    return routeError(error);
  }
}
