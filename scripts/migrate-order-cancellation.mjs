import { readFile } from "node:fs/promises";
import postgres from "postgres";

if (!process.env.DATABASE_URL_UNPOOLED) throw Error("Set the direct database URL for migration.");
const client = postgres(process.env.DATABASE_URL_UNPOOLED, { max: 1 });
try {
  await client.begin(async tx => {
    await tx.unsafe("SET LOCAL lock_timeout = '5s'");
    await tx.unsafe(await readFile(new URL("../drizzle/0015_order_cancellation.sql", import.meta.url), "utf8"));
  });
  const [column] = await client`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'commerce_orders' AND column_name = 'cancelled_at'`;
  const [fn] = await client`SELECT count(*)::int AS count FROM pg_proc WHERE proname = 'cancel_commerce_order' AND pronargs = 3`;
  const [constraint] = await client`SELECT count(*)::int AS count FROM pg_constraint WHERE conname = 'inventory_reservations_release_check' AND pg_get_constraintdef(oid) LIKE '%order_cancelled%'`;
  if (column.count !== 1 || fn.count !== 1 || constraint.count !== 1) throw Error("Order cancellation migration verification failed.");
  console.log("Buyer-authorized order cancellation and reservation restoration installed.");
} finally {
  await client.end();
}
