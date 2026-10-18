import { createHash } from "node:crypto";
import { verifyRazorpaySignature } from "./razorpay-signature";

export type PaymentCheckoutRequest = {
  intentId: string;
  amount: number;
  currency: string;
  receipt: string;
  metadata: Record<string, string>;
};

export type PaymentCheckoutResult = {
  providerOrderId: string;
  amount: number;
  currency: string;
  publicKeyId?: string;
  raw: Record<string, unknown>;
};

export type PaymentVerificationRequest = {
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
};

export type CapturedPaymentVerificationRequest = PaymentVerificationRequest & { amount: number; currency: string };

export type PaymentVerificationResult = {
  verified: boolean;
  raw: Record<string, unknown>;
};

export type RefundRequest = {
  providerPaymentId: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  reason: string;
};

export type RefundResult = {
  providerRefundId: string;
  status: "succeeded";
  raw: Record<string, unknown>;
};

export interface PaymentProvider {
  readonly name: "internal_test" | "razorpay_test";
  createCheckout(request: PaymentCheckoutRequest): Promise<PaymentCheckoutResult>;
  verifyPayment(request: PaymentVerificationRequest): Promise<PaymentVerificationResult>;
  verifyCapturedPayment(request: CapturedPaymentVerificationRequest): Promise<PaymentVerificationResult>;
  refund(request: RefundRequest): Promise<RefundResult>;
}

export function createInternalTestSignature(providerOrderId: string, providerPaymentId: string) {
  return createHash("sha256").update(`internal_test:${providerOrderId}:${providerPaymentId}`).digest("hex");
}

export class InternalTestPaymentProvider implements PaymentProvider {
  readonly name = "internal_test" as const;

  async createCheckout(request: PaymentCheckoutRequest): Promise<PaymentCheckoutResult> {
    const digest = createHash("sha256").update(`${request.intentId}:${request.receipt}`).digest("hex").slice(0, 24);
    return {
      providerOrderId: `order_test_${digest}`,
      amount: request.amount,
      currency: request.currency,
      raw: { provider: this.name, action: "create_checkout", amount: request.amount, currency: request.currency, receipt: request.receipt },
    };
  }

  async verifyPayment(request: PaymentVerificationRequest): Promise<PaymentVerificationResult> {
    const verified = request.signature === createInternalTestSignature(request.providerOrderId, request.providerPaymentId);
    return { verified, raw: { provider: this.name, action: "verify_payment", verified } };
  }

  async verifyCapturedPayment(request: CapturedPaymentVerificationRequest): Promise<PaymentVerificationResult> {
    return this.verifyPayment(request);
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    const digest = createHash("sha256").update(`${request.providerPaymentId}:${request.idempotencyKey}`).digest("hex").slice(0, 24);
    return {
      providerRefundId: `rf_test_${digest}`,
      status: "succeeded",
      raw: { provider: this.name, action: "refund", amount: request.amount, currency: request.currency, idempotencyKey: request.idempotencyKey },
    };
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type RazorpayConfig = {
  keyId: string;
  keySecret: string;
  fetcher?: FetchLike;
};

function razorpayError(action: string, status: number, payload: unknown) {
  const description = typeof payload === "object" && payload && "error" in payload
    ? (payload as { error?: { description?: unknown } }).error?.description
    : undefined;
  const message = typeof description === "string" ? description : `Razorpay ${action} failed`;
  return new Error(`${message} (HTTP ${status})`);
}

export class RazorpayTestPaymentProvider implements PaymentProvider {
  readonly name = "razorpay_test" as const;
  private readonly fetcher: FetchLike;

  constructor(private readonly config: RazorpayConfig) {
    if (!config.keyId.startsWith("rzp_test_") || !config.keySecret) throw new Error("Razorpay test mode is not configured");
    this.fetcher = config.fetcher ?? fetch;
  }

  private async request(path: string, method: "GET" | "POST", body?: Record<string, unknown>) {
    const authorization = `Basic ${Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString("base64")}`;
    const response = await this.fetcher(`https://api.razorpay.com/v1${path}`, {
      method,
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) throw razorpayError(path, response.status, payload);
    return payload;
  }

  async createCheckout(request: PaymentCheckoutRequest): Promise<PaymentCheckoutResult> {
    if (!Number.isInteger(request.amount) || request.amount <= 0 || request.currency !== "INR") throw new Error("Invalid Razorpay checkout amount");
    const payload = await this.request("/orders", "POST", {
      amount: request.amount * 100,
      currency: request.currency,
      receipt: request.receipt.slice(0, 40),
      notes: request.metadata,
    }) as { id?: unknown; amount?: unknown; currency?: unknown };
    if (typeof payload.id !== "string" || typeof payload.amount !== "number" || typeof payload.currency !== "string") throw new Error("Razorpay checkout response was incomplete");
    return { providerOrderId: payload.id, amount: payload.amount, currency: payload.currency, publicKeyId: this.config.keyId, raw: payload as Record<string, unknown> };
  }

  async verifyPayment(request: PaymentVerificationRequest): Promise<PaymentVerificationResult> {
    const verified = await verifyRazorpaySignature(request.providerOrderId, request.providerPaymentId, request.signature, this.config.keySecret);
    return { verified, raw: { provider: this.name, action: "verify_payment", verified } };
  }

  async verifyCapturedPayment(request: CapturedPaymentVerificationRequest): Promise<PaymentVerificationResult> {
    if (!Number.isSafeInteger(request.amount) || !Number.isSafeInteger(request.amount * 100) || request.amount <= 0 || request.currency !== "INR" || !/^pay_[A-Za-z0-9_]+$/.test(request.providerPaymentId)) {
      return { verified: false, raw: { provider: this.name, action: "verify_payment", verified: false } };
    }
    const signatureValid = await verifyRazorpaySignature(request.providerOrderId, request.providerPaymentId, request.signature, this.config.keySecret);
    if (!signatureValid) return { verified: false, raw: { provider: this.name, action: "verify_payment", verified: false } };
    const payment = await this.request(`/payments/${encodeURIComponent(request.providerPaymentId)}`, "GET") as Record<string, unknown>;
    const verified = payment.id === request.providerPaymentId && payment.order_id === request.providerOrderId &&
      payment.status === "captured" && payment.amount === request.amount * 100 && payment.currency === request.currency;
    return { verified, raw: { provider: this.name, action: "verify_payment", verified, status: payment.status } };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    if (!Number.isInteger(request.amount) || request.amount <= 0 || request.currency !== "INR") throw new Error("Invalid Razorpay refund amount");
    const payload = await this.request(`/payments/${encodeURIComponent(request.providerPaymentId)}/refund`, "POST", {
      amount: request.amount * 100,
      notes: { reason: request.reason, idempotency_key: request.idempotencyKey },
    }) as { id?: unknown; status?: unknown };
    if (typeof payload.id !== "string" || payload.status !== "processed") throw new Error("Razorpay refund response was incomplete");
    return { providerRefundId: payload.id, status: "succeeded", raw: payload as Record<string, unknown> };
  }
}

export function paymentProvider(name: string): PaymentProvider | null {
  if (name === "internal_test") return new InternalTestPaymentProvider();
  if (name !== "razorpay_test") return null;
  const keyId = process.env.RAZORPAY_TEST_KEY_ID;
  const keySecret = process.env.RAZORPAY_TEST_KEY_SECRET;
  if (!keyId?.startsWith("rzp_test_") || !keySecret) return null;
  return new RazorpayTestPaymentProvider({ keyId, keySecret });
}
