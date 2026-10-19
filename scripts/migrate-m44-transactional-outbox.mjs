import { readFile } from "node:fs/promises";
import postgres from "postgres";

if (!process.env.DATABASE_URL_UNPOOLED) throw Error("Set the direct database URL in DATABASE_URL_UNPOOLED.");

const client = postgres(process.env.DATABASE_URL_UNPOOLED, { max: 1 });
try {
  await client.begin(async tx => {
    await tx.unsafe("SET LOCAL lock_timeout = '5s'");
    await tx.unsafe(await readFile(new URL("../drizzle/0023_transactional_outbox_guards.sql", import.meta.url), "utf8"));
  });

  const [triggers] = await client`
    SELECT count(*)::int AS count
    FROM pg_trigger
    WHERE NOT tgisinternal AND tgname IN (
      'commerce_orders_outbox_consistency', 'payment_intents_outbox_consistency',
      'refunds_outbox_consistency', 'outbox_events_consistency'
    )
  `;
  const [functions] = await client`
    SELECT count(*)::int AS count
    FROM pg_proc
    WHERE proname IN ('assert_order_outbox_consistency', 'check_order_outbox_consistency_trigger')
  `;
  if (triggers.count !== 4 || functions.count !== 2) throw Error("M-44 trigger verification failed.");
  console.log("M-44 verified: four deferred database guards enforce order/payment/refund and outbox consistency at commit.");
} finally {
  await client.end();
}
