import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { commissionForItem, commissionReport } from '../lib/commission-service';

const source = { orderId: 'order', variantId: 'variant', storeId: 'store', quantity: 1, lineTotal: 29999, orderTotal: 29999, orderStatus: 'paid', commissionRateBps: 500, refundId: null, refundStatus: null, refundAmount: null };
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
    assert.throws(() => commissionForItem({ ...source, commissionRateBps: null }));
  });
  it('uses the historical item rate and rounds sub-paise amounts', () => {
    assert.equal(commissionForItem({ ...source, lineTotal: 1, orderTotal: 1, commissionRateBps: 125 }).netCommissionPaise, 1);
    assert.equal(commissionForItem({ ...source, commissionRateBps: 750 }).netCommissionPaise, 224993);
  });
  it('reconciles all items in a multi-item order and reverses a full refund', () => {
    const first = { ...source, lineTotal: 100, orderTotal: 300, orderStatus: 'refunded', refundId: 'refund', refundStatus: 'succeeded', refundAmount: 300 };
    const second = { ...first, variantId: 'variant-2', lineTotal: 200 };
    const report = commissionReport([first, second]);
    assert.equal(report.totals.grossCommissionPaise, 1500);
    assert.equal(report.totals.reversalPaise, 1500);
    assert.equal(report.totals.netCommissionPaise, 0);
    assert.throws(() => commissionReport([first]));
    assert.throws(() => commissionReport([first, first]));
    assert.throws(() => commissionReport([first, { ...second, refundAmount: 200 }]));
  });
});
