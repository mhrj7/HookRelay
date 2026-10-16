import { readFile } from "node:fs/promises";
import postgres from "postgres";

if (!process.env.DATABASE_URL_UNPOOLED) throw Error("Set the direct database URL for migration.");
const client = postgres(process.env.DATABASE_URL_UNPOOLED, { max: 1 });
try {
  await client.begin(async tx => { await tx.unsafe("SET LOCAL lock_timeout = '5s'"); await tx.unsafe(await readFile(new URL("../drizzle/0014_checkout_idempotency.sql", import.meta.url), "utf8")); });
  const [columns] = await client`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'commerce_orders' AND column_name IN ('idempotency_key', 'request_fingerprint') AND is_nullable = 'NO'`;
  const [uniqueKey] = await client`SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'commerce_orders' AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE '%(buyer_id, idempotency_key)%'`;
  const [fn] = await client`SELECT count(*)::int AS count FROM pg_proc WHERE proname = 'create_cart_checkout' AND pronargs = 6`;
  if (columns.count !== 2 || uniqueKey.count < 1 || fn.count !== 1) throw Error("Checkout idempotency migration verification failed.");
  console.log("Buyer-scoped checkout and payment-intent idempotency installed.");
} finally { await client.end(); }
