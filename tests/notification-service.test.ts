import assert from "node:assert/strict";
import test from "node:test";
import { deliverNotification, ResendEmailNotificationProvider, type NotificationStore } from "../lib/notification-service";

type Row = { id: string; recipientId: number; eventKey: string; channel: "in_app" | "email"; status: "pending" | "delivered" | "failed" | "skipped"; failureReason?: string | null; providerMessageId?: string | null; deliveredAt?: string | null };

function store() {
  const rows: Row[] = [];
  const value: NotificationStore = {
    async createIfAbsent(input) {
      const existing = rows.find(row => row.recipientId === input.recipientId && row.eventKey === input.eventKey && row.channel === input.channel);
      if (existing) return { created: false, notification: existing };
      const row: Row = { id: `notice-${rows.length + 1}`, recipientId: input.recipientId, eventKey: input.eventKey, channel: input.channel, status: input.status, failureReason: input.failureReason };
      rows.push(row); return { created: true, notification: row };
    },
    async update(id, update) {
      const row = rows.find(item => item.id === id); if (!row) throw new Error("Missing test notification");
      Object.assign(row, update);
    },
  };
  return { rows, value };
}

const event = { eventKey: "order:one:accepted:buyer", eventType: "order.accepted", recipientId: 7, recipientEmail: "buyer@example.test", title: "Order request accepted", body: "Your order was accepted." };

test("M-39 delivers one in-app and one email notification once per recipient event", async () => {
  const memory = store();
  let sends = 0;
  const provider = { async send(input: { to: string; subject: string; text: string; idempotencyKey: string }) { sends++; assert.equal(input.to, "buyer@example.test"); assert.equal(input.idempotencyKey, "order:one:accepted:buyer:7:email"); return { messageId: "email-001" }; } };
  await deliverNotification(event, memory.value, provider, "2026-10-16T12:00:00.000Z");
  await deliverNotification(event, memory.value, provider, "2026-10-16T12:01:00.000Z");
  assert.equal(sends, 1);
  assert.deepEqual(memory.rows.map(row => [row.channel, row.status, row.providerMessageId]), [["in_app", "delivered", undefined], ["email", "delivered", "email-001"]]);
});

test("M-39 records email delivery as skipped when no configured provider can send it", async () => {
  const memory = store();
  await deliverNotification(event, memory.value, null, "2026-10-16T12:00:00.000Z");
  assert.equal(memory.rows.find(row => row.channel === "in_app")?.status, "delivered");
  assert.equal(memory.rows.find(row => row.channel === "email")?.status, "skipped");
  assert.equal(memory.rows.find(row => row.channel === "email")?.failureReason, "Email provider is not configured.");
});

test("M-39 Resend adapter uses a provider idempotency key and never includes the API key in an error", async () => {
  let request: RequestInit | undefined;
  const provider = new ResendEmailNotificationProvider("test-secret", "VyapaarCart <updates@example.test>", async (_url, init) => { request = init; return Response.json({ message: "Rejected" }, { status: 401 }); });
  await assert.rejects(provider.send({ to: "buyer@example.test", subject: "Update", text: "Hello", idempotencyKey: "event-key" }), (error: unknown) => error instanceof Error && error.message === "Rejected (HTTP 401)");
  assert.equal((request?.headers as Record<string, string>)["Idempotency-Key"], "event-key");
  assert.equal(JSON.parse(String(request?.body)).to[0], "buyer@example.test");
});
