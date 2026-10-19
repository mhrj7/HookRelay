import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { auditEvents, users } from "../db/schema";
import type { Actor } from "./authorization";

type OrganizationMemberResult = {
  userId: number;
  userRole: string;
  membershipRole: string | null;
  auditRecorded: boolean;
};

type SellerApprovalResult = { sellerId: number; status: "approved" | "rejected" };

function rowsOf<T>(result: unknown) {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

export async function decideSellerApproval(input: { actor: Actor; sellerId: number; decision: "approved" | "rejected" }) {
  const db = getDb();
  const auditId = crypto.randomUUID();
  const result = await db.execute(sql`
    WITH target AS MATERIALIZED (
      SELECT id, seller_approval_status FROM users
      WHERE id = ${input.sellerId} AND seller_approval_status = 'pending'
      FOR UPDATE
    ), changed AS (
      UPDATE users u SET
        role = CASE WHEN ${input.decision}::text = 'approved' THEN 'seller' ELSE 'buyer' END,
        seller_approval_status = ${input.decision},
        seller_approved_at = CASE WHEN ${input.decision}::text = 'approved' THEN CURRENT_TIMESTAMP::text ELSE NULL END,
        seller_approved_by_id = ${input.actor.id}
      FROM target t WHERE u.id = t.id
      RETURNING u.id, u.seller_approval_status
    ), logged AS (
      INSERT INTO seller_approval_audits (id, seller_id, admin_id, action, previous_status, next_status, created_at)
      SELECT ${auditId}, c.id, ${input.actor.id}, ${input.decision}, t.seller_approval_status, c.seller_approval_status, CURRENT_TIMESTAMP::text
      FROM changed c JOIN target t ON t.id = c.id
      RETURNING seller_id, next_status
    )
    SELECT seller_id AS "sellerId", next_status AS status FROM logged
  `);
  return rowsOf<SellerApprovalResult>(result)[0] ?? null;
}

export async function saveOrganizationMemberRole(input: {
  actor: Actor;
  organizationId: string;
  organizationOwnerId: number;
  memberId: number;
  membershipRole: "manager" | "member";
}) {
  const db = getDb();
  const auditId = crypto.randomUUID();
  const result = await db.execute(sql`
    WITH locked_user AS MATERIALIZED (
      SELECT id, role, staff_for_seller_id, seller_approval_status
      FROM users WHERE id = ${input.memberId} FOR UPDATE
    ), existing_member AS MATERIALIZED (
      SELECT role FROM organization_members
      WHERE organization_id = ${input.organizationId} AND user_id = ${input.memberId}
      FOR UPDATE
    ), changed_user AS (
      UPDATE users u SET
        role = CASE WHEN l.role = 'admin' THEN l.role ELSE 'seller_staff' END,
        staff_for_seller_id = CASE WHEN l.role = 'admin' THEN l.staff_for_seller_id ELSE ${input.organizationOwnerId} END,
        seller_approval_status = CASE WHEN l.role = 'admin' THEN l.seller_approval_status ELSE 'approved' END
      FROM locked_user l WHERE u.id = l.id
        AND (SELECT count(*) FROM existing_member) >= 0
      RETURNING u.id, u.role, u.staff_for_seller_id, u.seller_approval_status
    ), saved_member AS (
      INSERT INTO organization_members (organization_id, user_id, role, created_at)
      SELECT ${input.organizationId}, id, ${input.membershipRole}, ${new Date().toISOString()} FROM changed_user
      ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role
      RETURNING user_id, role
    ), logged AS (
      INSERT INTO audit_events (
        id, actor_id, actor_role, action, target_type, target_id,
        before_summary, after_summary, metadata, source_type, source_id
      )
      SELECT
        ${auditId}, ${input.actor.id}, ${input.actor.role},
        CASE WHEN NOT EXISTS (SELECT 1 FROM existing_member) THEN 'organization.member.added'
             ELSE 'organization.member.role_changed' END,
        'organization_member', ${input.organizationId}::text || ':' || ${input.memberId}::text,
        jsonb_build_object(
          'membershipRole', (SELECT role FROM existing_member),
          'userRole', l.role,
          'staffForSellerId', l.staff_for_seller_id,
          'memberExists', EXISTS (SELECT 1 FROM existing_member)
        ),
        jsonb_build_object(
          'membershipRole', s.role,
          'userRole', c.role,
          'staffForSellerId', c.staff_for_seller_id,
          'memberExists', true
        ),
        jsonb_build_object('organizationId', ${input.organizationId}::text, 'organizationOwnerId', ${input.organizationOwnerId}::integer),
        'organization_member', ${auditId}
      FROM locked_user l
      JOIN changed_user c ON c.id = l.id
      JOIN saved_member s ON s.user_id = l.id
      WHERE NOT EXISTS (SELECT 1 FROM existing_member WHERE role = s.role)
         OR l.role IS DISTINCT FROM c.role
         OR l.staff_for_seller_id IS DISTINCT FROM c.staff_for_seller_id
      RETURNING id
    )
    SELECT c.id AS "userId", c.role AS "userRole", s.role AS "membershipRole",
      EXISTS (SELECT 1 FROM logged) AS "auditRecorded"
    FROM changed_user c JOIN saved_member s ON s.user_id = c.id
  `);
  return rowsOf<OrganizationMemberResult>(result)[0] ?? null;
}

export async function removeOrganizationMemberRole(input: {
  actor: Actor;
  organizationId: string;
  organizationOwnerId: number;
  memberId: number;
}) {
  const db = getDb();
  const auditId = crypto.randomUUID();
  const result = await db.execute(sql`
    WITH locked_user AS MATERIALIZED (
      SELECT id, role, staff_for_seller_id, seller_approval_status
      FROM users WHERE id = ${input.memberId} FOR UPDATE
    ), existing_member AS MATERIALIZED (
      SELECT role FROM organization_members
      WHERE organization_id = ${input.organizationId} AND user_id = ${input.memberId}
      FOR UPDATE
    ), changed_user AS (
      UPDATE users u SET
        role = CASE WHEN l.role = 'seller_staff' AND l.staff_for_seller_id = ${input.organizationOwnerId} THEN 'buyer' ELSE l.role END,
        staff_for_seller_id = CASE WHEN l.role = 'seller_staff' AND l.staff_for_seller_id = ${input.organizationOwnerId} THEN NULL ELSE l.staff_for_seller_id END,
        seller_approval_status = CASE WHEN l.role = 'seller_staff' AND l.staff_for_seller_id = ${input.organizationOwnerId} THEN 'not_requested' ELSE l.seller_approval_status END
      FROM locked_user l
      WHERE u.id = l.id AND EXISTS (SELECT 1 FROM existing_member)
      RETURNING u.id, u.role, u.staff_for_seller_id, u.seller_approval_status
    ), removed_member AS (
      DELETE FROM organization_members m
      USING changed_user c
      WHERE m.organization_id = ${input.organizationId} AND m.user_id = c.id
      RETURNING m.user_id, m.role
    ), logged AS (
      INSERT INTO audit_events (
        id, actor_id, actor_role, action, target_type, target_id,
        before_summary, after_summary, metadata, source_type, source_id
      )
      SELECT
        ${auditId}, ${input.actor.id}, ${input.actor.role}, 'organization.member.removed',
        'organization_member', ${input.organizationId}::text || ':' || ${input.memberId}::text,
        jsonb_build_object('membershipRole', r.role, 'userRole', l.role, 'staffForSellerId', l.staff_for_seller_id, 'memberExists', true),
        jsonb_build_object('membershipRole', NULL, 'userRole', c.role, 'staffForSellerId', c.staff_for_seller_id, 'memberExists', false),
        jsonb_build_object('organizationId', ${input.organizationId}::text, 'organizationOwnerId', ${input.organizationOwnerId}::integer),
        'organization_member', ${auditId}
      FROM locked_user l
      JOIN changed_user c ON c.id = l.id
      JOIN removed_member r ON r.user_id = l.id
      RETURNING id
    )
    SELECT c.id AS "userId", c.role AS "userRole", NULL::text AS "membershipRole",
      EXISTS (SELECT 1 FROM logged) AS "auditRecorded"
    FROM changed_user c
  `);
  return rowsOf<OrganizationMemberResult>(result)[0] ?? null;
}

export async function latestAuditEvents(limit = 100) {
  const db = getDb();
  return db.select({
    id: auditEvents.id,
    actorId: auditEvents.actorId,
    actorName: users.displayName,
    actorRole: auditEvents.actorRole,
    action: auditEvents.action,
    targetType: auditEvents.targetType,
    targetId: auditEvents.targetId,
    beforeSummary: auditEvents.beforeSummary,
    afterSummary: auditEvents.afterSummary,
    metadata: auditEvents.metadata,
    createdAt: auditEvents.createdAt,
  }).from(auditEvents).innerJoin(users, eq(auditEvents.actorId, users.id))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(Math.min(Math.max(limit, 1), 200));
}
