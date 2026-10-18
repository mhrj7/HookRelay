// Checkout stores the policy on each item. Amounts are rupees; results are paise.
export class CommissionDataError extends Error {}

export type CommissionSource = {
  orderId: string; variantId: string; storeId: string; quantity: number;
  lineTotal: number; orderTotal: number; orderStatus: string; commissionRateBps: number | null;
  refundId: string | null; refundStatus: string | null; refundAmount: number | null;
};

export function commissionForItem(source: CommissionSource) {
  if (!Number.isSafeInteger(source.quantity) || source.quantity <= 0) throw new CommissionDataError('Invalid order item quantity');
  if (!Number.isSafeInteger(source.lineTotal) || source.lineTotal <= 0 || !Number.isSafeInteger(source.orderTotal) || source.orderTotal < source.lineTotal) throw new CommissionDataError('Invalid order item amount');
  if (!['paid', 'refunded'].includes(source.orderStatus)) throw new CommissionDataError('Order is not settled');
  if (source.commissionRateBps === null || !Number.isInteger(source.commissionRateBps) || source.commissionRateBps < 0 || source.commissionRateBps > 10000) throw new CommissionDataError('An order item has no valid saved commission rate');
  const refunded = source.refundStatus === 'succeeded';
  // Partial refunds are not supported by the current checkout workflow. Refuse
  // to silently misreport them if data changes or a future workflow adds them.
  if ((refunded && source.refundAmount !== source.orderTotal) || (source.orderStatus === 'refunded' && !refunded) || (source.orderStatus === 'paid' && refunded)) throw new CommissionDataError('Order and refund records require reconciliation');
  const grossCommissionPaise = Math.round(source.lineTotal * source.commissionRateBps / 100);
  if (!Number.isSafeInteger(grossCommissionPaise)) throw new CommissionDataError('Commission amount exceeds supported precision');
  return { ...source, grossCommissionPaise, refundedItemAmount: refunded ? source.lineTotal : 0, reversalPaise: refunded ? grossCommissionPaise : 0, netCommissionPaise: refunded ? 0 : grossCommissionPaise };
}

// A per-item check alone cannot detect an incomplete or duplicated order.
// Reconcile the entire item set before reporting any financial totals.
export function commissionReport(sources: CommissionSource[]) {
  const orders = new Map<string, { total: number; sum: number; variants: Set<string>; status: string; refundId: string | null; refundStatus: string | null; refundAmount: number | null }>();
  const items = sources.map(source => {
    const item = commissionForItem(source);
    const order = orders.get(source.orderId) ?? { total: source.orderTotal, sum: 0, variants: new Set<string>(), status: source.orderStatus, refundId: source.refundId, refundStatus: source.refundStatus, refundAmount: source.refundAmount };
    if (order.total !== source.orderTotal || order.status !== source.orderStatus || order.refundId !== source.refundId || order.refundStatus !== source.refundStatus || order.refundAmount !== source.refundAmount || order.variants.has(source.variantId)) throw new CommissionDataError('Inconsistent or duplicate order items');
    order.variants.add(source.variantId);
    order.sum += source.lineTotal;
    if (!Number.isSafeInteger(order.sum)) throw new CommissionDataError('Order total exceeds supported precision');
    orders.set(source.orderId, order);
    return item;
  });
  for (const order of orders.values()) if (order.sum !== order.total) throw new CommissionDataError('Order items do not reconcile to order total');
  const totals = items.reduce((sum, item) => {
    const result = { grossCommissionPaise: sum.grossCommissionPaise + item.grossCommissionPaise, reversalPaise: sum.reversalPaise + item.reversalPaise, netCommissionPaise: sum.netCommissionPaise + item.netCommissionPaise };
    if (!Object.values(result).every(Number.isSafeInteger)) throw new CommissionDataError('Commission total exceeds supported precision');
    return result;
  }, { grossCommissionPaise: 0, reversalPaise: 0, netCommissionPaise: 0 });
  return { items, totals };
}
