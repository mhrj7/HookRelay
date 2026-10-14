import { readFile } from "node:fs/promises";
import postgres from "postgres";

if (!process.env.DATABASE_URL_UNPOOLED) throw Error("Set the direct database URL for migration.");
const client = postgres(process.env.DATABASE_URL_UNPOOLED, { max: 1 });
try {
  const migration = await readFile(new URL("../drizzle/0011_reservation_release.sql", import.meta.url), "utf8");
  await client.begin(async tx => {
    await tx.unsafe("SET LOCAL lock_timeout = '5s'");
    await tx.unsafe(migration);
  });
  const [columns] = await client`SELECT count(*)::int AS count FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory_reservations' AND column_name IN ('released_at', 'release_reason')`;
  const [functions] = await client`SELECT count(*)::int AS count FROM pg_proc
    WHERE proname IN ('release_inventory_after_payment_failure', 'reserve_inventory')`;
  const [constraint] = await client`SELECT count(*)::int AS count FROM pg_constraint
    WHERE conname = 'inventory_reservations_release_check'`;
  if (columns.count !== 2 || functions.count !== 2 || constraint.count !== 1) throw Error("Reservation release migration verification failed.");
  console.log("Reservation payment-failure release state and database functions installed.");
} finally {
  await client.end();
}
