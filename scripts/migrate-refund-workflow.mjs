import { readFile } from "node:fs/promises";
import postgres from "postgres";

if (!process.env.DATABASE_URL_UNPOOLED) throw Error("Set the direct database URL for migration.");
const client = postgres(process.env.DATABASE_URL_UNPOOLED, { max: 1 });
try {
  await client.begin(async tx => {
    await tx.unsafe("SET LOCAL lock_timeout = '5s'");
    await tx.unsafe(await readFile(new URL("../drizzle/0016_refund_workflow.sql", import.meta.url), "utf8"));
  });
  const [tables] = await client`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('refunds', 'refund_audits')`;
  const [functions] = await client`SELECT count(*)::int AS count FROM pg_proc WHERE proname IN ('begin_order_refund', 'complete_order_refund', 'fail_order_refund')`;
  const [indexes] = await client`SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('refunds_order_id_key', 'refunds_requested_by_idempotency_key_key')`;
  if (tables.count !== 2 || functions.count !== 3 || indexes.count !== 2) throw Error("Refund workflow migration verification failed.");
  console.log("Authorized refund workflow, provider result, and immutable audit records installed.");
} finally {
  await client.end();
}
