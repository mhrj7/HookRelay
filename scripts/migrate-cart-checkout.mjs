import { readFile } from "node:fs/promises";
import postgres from "postgres";

if (!process.env.DATABASE_URL_UNPOOLED) throw Error("Set the direct database URL for migration.");
const client = postgres(process.env.DATABASE_URL_UNPOOLED, { max: 1 });
try {
  await client.begin(async tx => {
    await tx.unsafe("SET LOCAL lock_timeout = '5s'");
    await tx.unsafe(await readFile(new URL("../drizzle/0013_cart_checkout.sql", import.meta.url), "utf8"));
  });
  const [tables] = await client`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('commerce_orders', 'commerce_order_items', 'payment_intents', 'outbox_events')`;
  const [fn] = await client`SELECT count(*)::int AS count FROM pg_proc WHERE proname = 'create_cart_checkout' AND pronargs = 5`;
  const [uniqueReservations] = await client`SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'commerce_order_items' AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE '%(reservation_id)%'`;
  if (tables.count !== 4 || fn.count !== 1 || uniqueReservations.count < 1) throw Error("Cart checkout migration verification failed.");
  console.log("Atomic cart checkout, payment intent, and outbox schema installed.");
} finally {
  await client.end();
}
