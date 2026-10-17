import { desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../../../db';
import { commerceOrderItems, commerceOrders, refunds } from '../../../../db/schema';
import { requireUser } from '../../../../lib/auth';
import { canAccessAdminOperations } from '../../../../lib/authorization';
import { commissionForItem, COMMISSION_RATE_BPS } from '../../../../lib/commission-service';
import { actorFor, routeError } from '../../../../lib/marketplace';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const identity = await requireUser(request);
    if (!identity) return Response.json({ error: 'Administrator access is required.' }, { status: 403 });
    const db = getDb();
    if (!canAccessAdminOperations(await actorFor(db, identity.clerkId))) return Response.json({ error: 'Administrator access is required.' }, { status: 403 });
    const sources = await db.select({ orderId: commerceOrders.id, orderStatus: commerceOrders.status, orderTotal: commerceOrders.total, createdAt: commerceOrders.createdAt, variantId: commerceOrderItems.variantId, storeId: commerceOrderItems.storeId, quantity: commerceOrderItems.quantity, lineTotal: commerceOrderItems.lineTotal, refundId: refunds.id, refundStatus: refunds.status, refundAmount: refunds.amount })
      .from(commerceOrders).innerJoin(commerceOrderItems, eq(commerceOrders.id, commerceOrderItems.orderId))
      .leftJoin(refunds, eq(commerceOrders.id, refunds.orderId)).where(inArray(commerceOrders.status, ['paid', 'refunded'])).orderBy(desc(commerceOrders.createdAt));
    const items = sources.map(commissionForItem);
    const totals = items.reduce((sum, item) => ({ grossCommissionPaise: sum.grossCommissionPaise + item.grossCommissionPaise, reversalPaise: sum.reversalPaise + item.reversalPaise, netCommissionPaise: sum.netCommissionPaise + item.netCommissionPaise }), { grossCommissionPaise: 0, reversalPaise: 0, netCommissionPaise: 0 });
    return Response.json({ rateBps: COMMISSION_RATE_BPS, items, totals }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return routeError(error); }
}
