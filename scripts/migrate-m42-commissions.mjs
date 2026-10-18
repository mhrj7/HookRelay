import { readFile } from "node:fs/promises";
import postgres from "postgres";

if (!process.env.DATABASE_URL_UNPOOLED) throw Error("Set the direct database URL for migration.");
const client = postgres(process.env.DATABASE_URL_UNPOOLED, { max: 1 });
try {
  const files = ["0019_commission_rate_snapshot.sql", "0020_commerce_payment_capture.sql", "0021_refund_provider_payment.sql"];
  await client.begin(async tx => {
    await tx.unsafe("SET LOCAL lock_timeout = '5s'");
    for (const file of files) await tx.unsafe(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  });
  const [columns] = await client`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payment_intents' AND column_name IN ('provider_order_id', 'provider_payment_id', 'provider_response', 'updated_at')`;
  const [functions] = await client`SELECT count(*)::int AS count FROM pg_proc WHERE proname IN ('begin_commerce_payment', 'store_commerce_payment_order', 'capture_commerce_payment', 'begin_order_refund')`;
  const [trigger] = await client`SELECT count(*)::int AS count FROM pg_trigger WHERE tgname = 'preserve_item_commission_rate' AND NOT tgisinternal`;
  if (columns.count !== 4 || functions.count !== 4 || trigger.count !== 1) throw Error("M-42 migration verification failed.");
  console.log("M-42 schema verified: immutable item commission snapshots, payment capture, provider-linked refunds, and reporting trace are installed.");
} finally { await client.end(); }
