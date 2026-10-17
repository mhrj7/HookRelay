// The current marketplace commission policy is a fixed 5% of each paid item.
// Amounts in the checkout tables are whole rupees; commissions use paise.
export const COMMISSION_RATE_BPS = 500;

export type CommissionSource = {
  orderId: string; variantId: string; storeId: string; quantity: number;
  lineTotal: number; orderTotal: number; orderStatus: string;
  refundId: string | null; refundStatus: string | null; refundAmount: number | null;
};

export function commissionForItem(source: CommissionSource) {
  if (!Number.isSafeInteger(source.lineTotal) || source.lineTotal <= 0 || !Number.isSafeInteger(source.orderTotal) || source.orderTotal < source.lineTotal) throw new Error('Invalid order item amount');
  if (!['paid', 'refunded'].includes(source.orderStatus)) throw new Error('Order is not settled');
  const refunded = source.refundStatus === 'succeeded';
  // Partial refunds are not supported by the current checkout workflow. Refuse
  // to silently misreport them if data changes or a future workflow adds them.
  if ((refunded && source.refundAmount !== source.orderTotal) || (source.orderStatus === 'refunded' && !refunded) || (source.orderStatus === 'paid' && refunded)) throw new Error('Order and refund records require reconciliation');
  const grossCommissionPaise = source.lineTotal * COMMISSION_RATE_BPS / 100;
  if (!Number.isSafeInteger(grossCommissionPaise)) throw new Error('Commission amount exceeds supported precision');
  return { ...source, rateBps: COMMISSION_RATE_BPS, grossCommissionPaise, refundedItemAmount: refunded ? source.lineTotal : 0, reversalPaise: refunded ? grossCommissionPaise : 0, netCommissionPaise: refunded ? 0 : grossCommissionPaise };
}
