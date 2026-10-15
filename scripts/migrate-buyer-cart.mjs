import { readFile } from "node:fs/promises";
import postgres from "postgres";

if (!process.env.DATABASE_URL_UNPOOLED) throw Error("Set the direct database URL for migration.");
const client = postgres(process.env.DATABASE_URL_UNPOOLED, { max: 1 });
try {
  const migration = await readFile(new URL("../drizzle/0012_buyer_cart.sql", import.meta.url), "utf8");
  await client.begin(async tx => {
    await tx.unsafe("SET LOCAL lock_timeout = '5s'");
    await tx.unsafe(migration);
  });
  const [tables] = await client`SELECT count(*)::int AS count FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('carts', 'cart_items')`;
  const [buyerUnique] = await client`SELECT count(*)::int AS count FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'carts' AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE '%(buyer_id)%'`;
  const [itemKey] = await client`SELECT count(*)::int AS count FROM pg_constraint
    WHERE conrelid = 'cart_items'::regclass AND contype = 'p' AND pg_get_constraintdef(oid) = 'PRIMARY KEY (cart_id, variant_id)'`;
  const [quantityCheck] = await client`SELECT count(*)::int AS count FROM pg_constraint
    WHERE conrelid = 'cart_items'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%quantity >= 1%quantity <= 20%'`;
  const [variantIndex] = await client`SELECT count(*)::int AS count FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'cart_items' AND indexdef LIKE '%(variant_id)%'`;
  if (tables.count !== 2 || buyerUnique.count < 1 || itemKey.count !== 1 || quantityCheck.count !== 1 || variantIndex.count < 1) {
    throw Error("Buyer cart migration verification failed.");
  }
  console.log("Buyer carts, cart items, ownership, and quantity constraints installed.");
} finally {
  await client.end();
}
