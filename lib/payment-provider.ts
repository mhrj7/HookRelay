import { createHash } from "node:crypto";

export type RefundRequest = {
  paymentIntentId: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  reason: string;
};

export type RefundResult = {
  providerRefundId: string;
  status: "succeeded";
  raw: Record<string, string | number>;
};

export interface PaymentProvider {
  readonly name: string;
  refund(request: RefundRequest): Promise<RefundResult>;
}

export class InternalTestPaymentProvider implements PaymentProvider {
  readonly name = "internal_test";

  async refund(request: RefundRequest): Promise<RefundResult> {
    const digest = createHash("sha256").update(`${request.paymentIntentId}:${request.idempotencyKey}`).digest("hex").slice(0, 24);
    return {
      providerRefundId: `rf_test_${digest}`,
      status: "succeeded",
      raw: { provider: this.name, action: "refund", amount: request.amount, currency: request.currency, idempotencyKey: request.idempotencyKey },
    };
  }
}

export function paymentProvider(name: string): PaymentProvider | null {
  return name === "internal_test" ? new InternalTestPaymentProvider() : null;
}
