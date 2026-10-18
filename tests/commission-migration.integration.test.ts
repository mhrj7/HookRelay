import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

test('M-42 migration preserves unknown historical rates and freezes new snapshots', { skip: process.env.RUN_COMMISSION_MIGRATION_INTEGRATION !== '1' }, async () => {
  assert.match(process.env.DATABASE_URL ?? '', /@(db|localhost|127\.0\.0\.1)(:|\/)/);
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const rollback = new Error('rollback isolated migration fixture');
  try {
    await assert.rejects(sql.begin(async tx => {
      await tx`CREATE TEMPORARY TABLE commerce_orders (id text PRIMARY KEY, status text NOT NULL) ON COMMIT DROP`;
      await tx`CREATE TEMPORARY TABLE commerce_order_items (order_id text NOT NULL, variant_id text NOT NULL) ON COMMIT DROP`;
      await tx`INSERT INTO commerce_orders VALUES ('pending', 'pending_payment'), ('old-paid', 'paid')`;
      await tx`INSERT INTO commerce_order_items VALUES ('pending', 'v1'), ('old-paid', 'v2')`;
      await tx.unsafe(await readFile(new URL('../drizzle/0019_commission_rate_snapshot.sql', import.meta.url), 'utf8'));
      const rows = await tx`SELECT order_id, commission_rate_bps FROM commerce_order_items ORDER BY order_id`;
      assert.deepEqual(rows.map(row => [row.order_id, row.commission_rate_bps]), [['old-paid', null], ['pending', 500]]);
      await tx`INSERT INTO commerce_order_items (order_id, variant_id) VALUES ('pending', 'v3')`;
      const [added] = await tx`SELECT commission_rate_bps FROM commerce_order_items WHERE variant_id = 'v3'`;
      assert.equal(added.commission_rate_bps, 500);
      await assert.rejects(tx.savepoint(inner => inner`UPDATE commerce_order_items SET commission_rate_bps = 750 WHERE variant_id = 'v3'`), /commission rate cannot be changed/);
      throw rollback;
    }), error => error === rollback);
  } finally { await sql.end(); }
});
