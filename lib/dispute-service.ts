export const disputeStatuses = ["open", "under_review", "resolved", "rejected"] as const;
export type DisputeStatus = (typeof disputeStatuses)[number];

export function parseDisputeCreate(input: unknown) {
  const value = input as { orderId?: unknown; reason?: unknown };
  const orderId = typeof value.orderId === "string" ? value.orderId.trim() : "";
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (!orderId || orderId.length > 120 || reason.length < 5 || reason.length > 500) return null;
  return { orderId, reason };
}

export function parseDisputeDecision(input: unknown, currentStatus: DisputeStatus) {
  const value = input as { status?: unknown; resolution?: unknown };
  const status = value.status;
  const resolution = typeof value.resolution === "string" ? value.resolution.trim() : "";
  if (status === "under_review" && currentStatus === "open") return { status, resolution: null } as const;
  if ((status === "resolved" || status === "rejected") && (currentStatus === "open" || currentStatus === "under_review") && resolution.length >= 5 && resolution.length <= 1000) return { status, resolution } as const;
  return null;
}
