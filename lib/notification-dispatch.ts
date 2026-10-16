import { and, eq } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import type { getDb } from "../db";
import { notifications, users } from "../db/schema";
import { deliverNotification, emailNotificationProvider, type NotificationEvent, type NotificationStore } from "./notification-service";

type Db = ReturnType<typeof getDb>;

function notificationStore(db: Db): NotificationStore {
  return {
    async createIfAbsent(input) {
      const id = crypto.randomUUID();
      const [created] = await db.insert(notifications).values({ id, recipientId: input.recipientId, eventKey: input.eventKey, eventType: input.eventType, channel: input.channel, title: input.title, body: input.body, status: input.status, failureReason: input.failureReason ?? null, createdAt: new Date().toISOString() }).onConflictDoNothing().returning();
      if (created) return { created: true, notification: { id: created.id, channel: created.channel as "in_app" | "email", status: created.status as "pending" | "delivered" | "failed" | "skipped" } };
      const [existing] = await db.select({ id: notifications.id, channel: notifications.channel, status: notifications.status }).from(notifications).where(and(eq(notifications.recipientId, input.recipientId), eq(notifications.eventKey, input.eventKey), eq(notifications.channel, input.channel))).limit(1);
      if (!existing) throw new Error("Notification delivery key could not be read.");
      return { created: false, notification: { id: existing.id, channel: existing.channel as "in_app" | "email", status: existing.status as "pending" | "delivered" | "failed" | "skipped" } };
    },
    async update(id, update) {
      await db.update(notifications).set({ status: update.status, providerMessageId: update.providerMessageId, failureReason: update.failureReason, deliveredAt: update.deliveredAt }).where(eq(notifications.id, id));
    },
  };
}

async function primaryEmail(clerkId: string) {
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(clerkId);
    return user.primaryEmailAddress?.emailAddress ?? null;
  } catch {
    return null;
  }
}

export async function dispatchOrderNotification(db: Db, event: Omit<NotificationEvent, "recipientEmail"> & { recipientClerkId: string }) {
  return deliverNotification({ ...event, recipientEmail: await primaryEmail(event.recipientClerkId) }, notificationStore(db), emailNotificationProvider());
}

export async function recipientFor(db: Db, userId: number) {
  const [recipient] = await db.select({ id: users.id, clerkId: users.clerkId }).from(users).where(eq(users.id, userId)).limit(1);
  if (!recipient) throw new Error("Notification recipient was not found.");
  return recipient;
}
