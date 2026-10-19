import { readFile } from "node:fs/promises";
import postgres from "postgres";

if (!process.env.DATABASE_URL_UNPOOLED) throw Error("Set the direct database URL for migration.");
const client = postgres(process.env.DATABASE_URL_UNPOOLED, { max: 1 });
try {
  await client.begin(async tx => {
    await tx.unsafe("SET LOCAL lock_timeout = '5s'");
    await tx.unsafe(await readFile(new URL("../drizzle/0022_central_audit_events.sql", import.meta.url), "utf8"));
  });
  const [columns] = await client`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'audit_events' AND column_name IN ('actor_id', 'actor_role', 'action', 'target_type', 'target_id', 'before_summary', 'after_summary', 'created_at')`;
  const [triggers] = await client`SELECT count(*)::int AS count FROM pg_trigger WHERE tgname IN ('audit_events_immutable', 'seller_approval_audits_to_central', 'inventory_audits_to_central', 'refund_audits_to_central') AND NOT tgisinternal`;
  if (columns.count !== 8 || triggers.count !== 4) throw Error("M-43 migration verification failed.");
  console.log("M-43 schema verified: central immutable audit events and all three legacy audit mirrors are installed.");
} finally {
  await client.end();
}
