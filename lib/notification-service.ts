export type NotificationChannel = "in_app" | "email";
export type NotificationStatus = "pending" | "delivered" | "failed" | "skipped";

export type NotificationEvent = {
  eventKey: string;
  eventType: string;
  recipientId: number;
  title: string;
  body: string;
  recipientEmail?: string | null;
};

export type StoredNotification = {
  id: string;
  channel: NotificationChannel;
  status: NotificationStatus;
};

export interface NotificationStore {
  createIfAbsent(notification: NotificationEvent & { channel: NotificationChannel; status: NotificationStatus; failureReason?: string | null }): Promise<{ created: boolean; notification: StoredNotification }>;
  update(id: string, update: { status: NotificationStatus; providerMessageId?: string | null; failureReason?: string | null; deliveredAt?: string | null }): Promise<void>;
}

export interface EmailNotificationProvider {
  send(input: { to: string; subject: string; text: string; idempotencyKey: string }): Promise<{ messageId: string }>;
}

export class ResendEmailNotificationProvider implements EmailNotificationProvider {
  constructor(private readonly apiKey: string, private readonly from: string, private readonly fetcher: typeof fetch = fetch) {
    if (!apiKey || !from) throw new Error("Resend email notifications are not configured");
  }

  async send(input: { to: string; subject: string; text: string; idempotencyKey: string }) {
    const response = await this.fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({ from: this.from, to: [input.to], subject: input.subject, text: input.text }),
    });
    const data: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof data === "object" && data && "message" in data && typeof (data as { message?: unknown }).message === "string" ? (data as { message: string }).message : "Email provider request failed";
      throw new Error(`${message} (HTTP ${response.status})`);
    }
    const id = typeof data === "object" && data && "id" in data && typeof (data as { id?: unknown }).id === "string" ? (data as { id: string }).id : null;
    if (!id) throw new Error("Email provider response was incomplete");
    return { messageId: id };
  }
}

export function emailNotificationProvider(): EmailNotificationProvider | null {
  if (process.env.NOTIFICATION_EMAIL_PROVIDER !== "resend") return null;
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFICATION_FROM_EMAIL;
  return apiKey && from ? new ResendEmailNotificationProvider(apiKey, from) : null;
}

export async function deliverNotification(event: NotificationEvent, store: NotificationStore, provider: EmailNotificationProvider | null, now = new Date().toISOString()) {
  const inApp = await store.createIfAbsent({ ...event, channel: "in_app", status: "delivered" });
  if (inApp.created) await store.update(inApp.notification.id, { status: "delivered", deliveredAt: now });

  if (!event.recipientEmail) {
    const email = await store.createIfAbsent({ ...event, channel: "email", status: "skipped", failureReason: "Recipient email is unavailable." });
    if (email.created) await store.update(email.notification.id, { status: "skipped", failureReason: "Recipient email is unavailable." });
    return { inApp, email };
  }
  if (!provider) {
    const email = await store.createIfAbsent({ ...event, channel: "email", status: "skipped", failureReason: "Email provider is not configured." });
    if (email.created) await store.update(email.notification.id, { status: "skipped", failureReason: "Email provider is not configured." });
    return { inApp, email };
  }
  const email = await store.createIfAbsent({ ...event, channel: "email", status: "pending" });
  if (!email.created) return { inApp, email };
  try {
    const sent = await provider.send({ to: event.recipientEmail, subject: event.title, text: event.body, idempotencyKey: `${event.eventKey}:${event.recipientId}:email` });
    await store.update(email.notification.id, { status: "delivered", providerMessageId: sent.messageId, deliveredAt: now });
  } catch (error) {
    await store.update(email.notification.id, { status: "failed", failureReason: error instanceof Error ? error.message : "Email provider request failed" });
  }
  return { inApp, email };
}
