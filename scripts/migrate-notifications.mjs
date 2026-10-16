import { readFile } from "node:fs/promises";
import postgres from "postgres";

if (!process.env.DATABASE_URL_UNPOOLED) throw Error("Set the direct database URL for migration.");
const client = postgres(process.env.DATABASE_URL_UNPOOLED, { max: 1 });
try {
  await client.begin(async tx => {
    await tx.unsafe("SET LOCAL lock_timeout = '5s'");
    await tx.unsafe(await readFile(new URL("../drizzle/0017_notifications.sql", import.meta.url), "utf8"));
  });
  const [table] = await client`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'notifications'`;
  const [index] = await client`SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'notifications_recipient_event_channel_key'`;
  if (table.count !== 1 || index.count !== 1) throw Error("Notification migration verification failed.");
  console.log("Notification storage and exactly-once delivery key installed.");
} finally {
  await client.end();
}
