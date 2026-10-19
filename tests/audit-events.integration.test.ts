import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDb } from "../db";
import { auditEvents, categories, commerceOrders, inventoryAudits, organizationMembers, organizations, outboxEvents, paymentIntents, products, productVariants, refundAudits, refunds, stores, users, warehouses } from "../db/schema";
import { decideSellerApproval, latestAuditEvents, removeOrganizationMemberRole, saveOrganizationMemberRole } from "../lib/audit-service";
import type { Actor } from "../lib/authorization";

test("M-43 SQL: sensitive changes produce immutable actor/target/before/after/timestamp audit events", {
  skip: process.env.RUN_AUDIT_EVENTS_INTEGRATION !== "1",
  timeout: 120000,
}, async (t) => {
  const isNeon = process.env.ALLOW_NEON_M43_INTEGRATION === "1";
  if (!isNeon) assert.match(process.env.DATABASE_URL ?? "", /@(db|localhost|127\.0\.0\.1)(:|\/)/);
  const db = getDb();
  const direct = postgres(process.env.DATABASE_URL!, { max: 1 });
  t.after(async () => { await direct.end(); });
  if (!isNeon) t.after(async () => { await (db as ReturnType<typeof drizzlePostgres>).$client.end(); });
  if (!isNeon) {
  await db.execute(sql.raw(await readFile(new URL("../drizzle/0000_glamorous_white_queen.sql", import.meta.url), "utf8")));
  await db.execute(sql.raw(`
    ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'buyer';
    ALTER TABLE users ADD COLUMN staff_for_seller_id integer;
  `));
  for (const file of ["0001_seller_approval.sql", "0002_public_stores.sql", "0003_jwt_refresh_tokens.sql", "0004_products_categories.sql", "0005_product_variants.sql", "0006_product_images.sql", "0008_warehouses.sql", "0009_inventory_audits.sql", "0010_inventory_reservations.sql", "0011_reservation_release.sql", "0012_buyer_cart.sql", "0013_cart_checkout.sql", "0014_checkout_idempotency.sql", "0015_order_cancellation.sql", "0016_refund_workflow.sql", "0017_notifications.sql", "0018_disputes.sql", "0019_commission_rate_snapshot.sql", "0020_commerce_payment_capture.sql", "0021_refund_provider_payment.sql", "0023_transactional_outbox_guards.sql"]) {
    await db.execute(sql.raw(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8")));
  }
  await db.execute(sql.raw(`
    CREATE TABLE organizations (
      id text PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE,
      owner_id integer NOT NULL REFERENCES users(id) ON DELETE cascade,
      created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );
    CREATE TABLE organization_members (
      organization_id text NOT NULL REFERENCES organizations(id) ON DELETE cascade,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE cascade,
      role text NOT NULL DEFAULT 'member', created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
      PRIMARY KEY (organization_id, user_id)
    );
  `));
  await db.execute(sql.raw(await readFile(new URL("../drizzle/0022_central_audit_events.sql", import.meta.url), "utf8")));
  }

  const tag = crypto.randomUUID();
  const [admin, seller, member] = await db.insert(users).values([
    { clerkId: `${tag}-admin`, displayName: "Audit Admin", role: "admin", sellerApprovalStatus: "approved" },
    { clerkId: `${tag}-seller`, displayName: "Audit Seller", role: "seller", sellerApprovalStatus: "pending" },
    { clerkId: `${tag}-member`, displayName: "Audit Member", role: "buyer", sellerApprovalStatus: "not_requested" },
  ]).returning();
  const actor: Actor = { id: admin.id, clerkId: admin.clerkId, role: "admin", staffForSellerId: null, sellerApprovalStatus: "approved" };

  assert.deepEqual(await decideSellerApproval({ actor, sellerId: seller.id, decision: "approved" }), { sellerId: seller.id, status: "approved" });
  const [approvalEvent] = await db.select().from(auditEvents).where(and(eq(auditEvents.action, "seller.approval.approved"), eq(auditEvents.targetId, String(seller.id))));
  assert.equal(approvalEvent.actorId, admin.id);
  assert.equal(approvalEvent.targetId, String(seller.id));
  assert.deepEqual(approvalEvent.beforeSummary, { approvalStatus: "pending" });
  assert.deepEqual(approvalEvent.afterSummary, { approvalStatus: "approved" });
  assert.ok(approvalEvent.createdAt instanceof Date);

  const organizationId = crypto.randomUUID();
  await db.insert(organizations).values({ id: organizationId, ownerId: seller.id, name: "Audit Org", slug: `audit-${tag}` });
  const added = await saveOrganizationMemberRole({ actor, organizationId, organizationOwnerId: seller.id, memberId: member.id, membershipRole: "manager" });
  assert.equal(added?.auditRecorded, true);
  const changed = await saveOrganizationMemberRole({ actor, organizationId, organizationOwnerId: seller.id, memberId: member.id, membershipRole: "member" });
  assert.equal(changed?.auditRecorded, true);
  const removed = await removeOrganizationMemberRole({ actor, organizationId, organizationOwnerId: seller.id, memberId: member.id });
  assert.equal(removed?.auditRecorded, true);
  assert.equal((await db.select().from(organizationMembers).where(eq(organizationMembers.organizationId, organizationId))).length, 0);

  const categoryId = crypto.randomUUID(); const storeId = crypto.randomUUID(); const productId = crypto.randomUUID(); const variantId = crypto.randomUUID(); const warehouseId = crypto.randomUUID();
  await db.insert(categories).values({ id: categoryId, name: "Audit", slug: `audit-${tag}` });
  await db.insert(stores).values({ id: storeId, ownerId: seller.id, name: "Audit Store", slug: `store-${tag}`, city: "Test", description: "Audit fixture" });
  await db.insert(products).values({ id: productId, storeId, categoryId, title: "Audit Product", description: "Audit fixture", price: 100 });
  await db.insert(productVariants).values({ id: variantId, productId, name: "Default", sku: `AUDIT-${tag}`, price: 100 });
  await db.insert(warehouses).values({ id: warehouseId, storeId, name: "Audit Warehouse", address: "Test", city: "Test", postcode: "560001" });
  const inventoryId = crypto.randomUUID();
  await db.insert(inventoryAudits).values({ id: inventoryId, storeId, warehouseId, variantId, actorId: seller.id, actorRole: "seller", sku: `AUDIT-${tag}`, previousQuantity: 2, quantity: 7, stockVersion: 3, reason: "Cycle count" });
  const [inventoryEvent] = await db.select().from(auditEvents).where(and(eq(auditEvents.sourceType, "inventory_audits"), eq(auditEvents.sourceId, inventoryId)));
  assert.deepEqual(inventoryEvent.beforeSummary, { quantity: 2, version: 2 });
  assert.deepEqual(inventoryEvent.afterSummary, { quantity: 7, version: 3 });

  const orderId = crypto.randomUUID(); const paymentId = crypto.randomUUID(); const refundId = crypto.randomUUID();
  await direct.begin(async tx => {
    await tx`INSERT INTO commerce_orders(id, buyer_id, idempotency_key, request_fingerprint, status, total) VALUES (${orderId}, ${member.id}, ${`${tag}-order`}, ${tag}, 'refunded', 100)`;
    await tx`INSERT INTO payment_intents(id, order_id, provider, status, amount) VALUES (${paymentId}, ${orderId}, 'internal_test', 'refunded', 100)`;
    await tx`INSERT INTO refunds(id, order_id, payment_intent_id, requested_by, idempotency_key, provider, provider_refund_id, amount, currency, reason, status) VALUES (${refundId}, ${orderId}, ${paymentId}, ${admin.id}, ${`${tag}-refund`}, 'internal_test', ${`${tag}-provider-refund`}, 100, 'INR', 'Audit test', 'succeeded')`;
    await tx`INSERT INTO outbox_events(id, aggregate_type, aggregate_id, event_type, payload) VALUES
      (${crypto.randomUUID()}, 'order', ${orderId}, 'order.created', ${JSON.stringify({ orderId })}),
      (${crypto.randomUUID()}, 'order', ${orderId}, 'order.paid', ${JSON.stringify({ orderId })}),
      (${crypto.randomUUID()}, 'order', ${orderId}, 'order.refunded', ${JSON.stringify({ orderId, refundId })})`;
  });
  const refundAuditId = crypto.randomUUID();
  await db.insert(refundAudits).values({ id: refundAuditId, refundId, actorId: admin.id, eventType: "refund.succeeded", fromStatus: "processing", toStatus: "succeeded", metadata: JSON.stringify({ providerRefundId: `${tag}-provider-refund` }) });
  const [refundEvent] = await db.select().from(auditEvents).where(and(eq(auditEvents.sourceType, "refund_audits"), eq(auditEvents.sourceId, refundAuditId)));
  assert.equal(refundEvent.actorId, admin.id);
  assert.deepEqual(refundEvent.beforeSummary, { status: "processing" });
  assert.deepEqual(refundEvent.afterSummary, { status: "succeeded" });

  const roleEvents = await db.select().from(auditEvents).where(and(eq(auditEvents.targetType, "organization_member"), eq(auditEvents.targetId, `${organizationId}:${member.id}`)));
  assert.deepEqual(roleEvents.map(event => event.action).sort(), ["organization.member.added", "organization.member.removed", "organization.member.role_changed"]);
  assert.ok(roleEvents.every(event => event.actorId === admin.id && event.createdAt instanceof Date && event.beforeSummary && event.afterSummary));
  assert.ok((await latestAuditEvents(200)).some(event => event.id === refundEvent.id));
  const immutableFailure = (error: unknown) => error instanceof Error && String((error as Error & { cause?: unknown }).cause).includes("immutable");
  await assert.rejects(db.update(auditEvents).set({ action: "tampered" }).where(eq(auditEvents.id, refundEvent.id)), immutableFailure);
  await assert.rejects(db.delete(auditEvents).where(eq(auditEvents.id, refundEvent.id)), immutableFailure);
  assert.equal((await db.select().from(auditEvents).where(inArray(auditEvents.id, [approvalEvent.id, inventoryEvent.id, refundEvent.id]))).length, 3);
});
