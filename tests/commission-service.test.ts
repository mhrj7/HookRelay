import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { commissionForItem } from '../lib/commission-service';

const source = { orderId: 'order', variantId: 'variant', storeId: 'store', quantity: 1, lineTotal: 29999, orderTotal: 29999, orderStatus: 'paid', refundId: null, refundStatus: null, refundAmount: null };
describe('item commissions', () => {
  it('calculates exactly in paise and ignores unsuccessful refunds', () => {
    assert.equal(commissionForItem(source).netCommissionPaise, 149995);
    assert.equal(commissionForItem({ ...source, refundId: 'refund', refundStatus: 'failed', refundAmount: 29999 }).netCommissionPaise, 149995);
  });
  it('traces and reverses successful whole-order refunds', () => {
    const result = commissionForItem({ ...source, orderStatus: 'refunded', refundId: 'refund', refundStatus: 'succeeded', refundAmount: 29999 });
    assert.equal(result.refundId, 'refund');
    assert.equal(result.reversalPaise, 149995);
    assert.equal(result.netCommissionPaise, 0);
  });
  it('fails closed for partial or inconsistent refund data', () => {
    assert.throws(() => commissionForItem({ ...source, orderStatus: 'refunded', refundId: 'refund', refundStatus: 'succeeded', refundAmount: 100 }));
    assert.throws(() => commissionForItem({ ...source, orderStatus: 'refunded' }));
  });
});
