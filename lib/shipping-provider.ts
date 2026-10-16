import { nextShipmentStep, shipmentMessage, type ShipmentStep, trackingNumber } from "./delivery";

export type ShippingAddress = {
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
};

export type ShipmentCreateRequest = {
  orderId: string;
  recipient: ShippingAddress;
  pickup: ShippingAddress & { location: string };
  item: { name: string; unitPrice: number };
  createdAt: string;
};

export type ShipmentCreateResult = {
  provider: string;
  trackingNumber: string;
  status: ShipmentStep;
  eta: string;
  message: string;
  providerShipmentId?: string;
  awbCode?: string;
  courierName?: string;
};

export type ShipmentAdvanceRequest = {
  trackingNumber: string;
  currentStatus: string;
  occurredAt: string;
};

export type ShipmentAdvanceResult = {
  status: ShipmentStep;
  message: string;
};

export interface ShippingProvider {
  readonly name: string;
  createShipment(request: ShipmentCreateRequest): Promise<ShipmentCreateResult>;
  advanceShipment(request: ShipmentAdvanceRequest): Promise<ShipmentAdvanceResult | null>;
}

export class LocalSandboxShippingProvider implements ShippingProvider {
  readonly name = "VyapaarCart sandbox carrier";

  async createShipment(request: ShipmentCreateRequest): Promise<ShipmentCreateResult> {
    return {
      provider: this.name,
      trackingNumber: trackingNumber(),
      status: "label_created",
      eta: new Date(new Date(request.createdAt).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      message: shipmentMessage("label_created"),
    };
  }

  async advanceShipment(request: ShipmentAdvanceRequest): Promise<ShipmentAdvanceResult | null> {
    const status = nextShipmentStep(request.currentStatus);
    return status ? { status, message: shipmentMessage(status) } : null;
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ShiprocketEnvironment = "sandbox" | "production";

function shiprocketBase(environment: ShiprocketEnvironment) {
  return environment === "sandbox" ? "https://api-sandbox.shiprocket.in/v1/external" : "https://apiv2.shiprocket.in/v1/external";
}

async function json(response: Response) {
  const value: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof value === "object" && value && "message" in value && typeof (value as { message?: unknown }).message === "string"
      ? (value as { message: string }).message : "Shiprocket request failed";
    throw new Error(`${message} (HTTP ${response.status})`);
  }
  return value as Record<string, unknown>;
}

function valueAt(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) if (typeof record[key] === "string" || typeof record[key] === "number") return String(record[key]);
  for (const nested of Object.values(record)) { const found = valueAt(nested, keys); if (found) return found; }
  return null;
}

export class ShiprocketShippingProvider implements ShippingProvider {
  readonly name: string;
  private readonly base: string;

  constructor(private readonly environment: ShiprocketEnvironment, private readonly email: string, private readonly password: string, private readonly fetcher: FetchLike = fetch) {
    if (!email || !password) throw new Error(`Shiprocket ${environment} is not configured`);
    this.name = `Shiprocket ${environment}`;
    this.base = shiprocketBase(environment);
  }

  private async token() {
    const response = await this.fetcher(`${this.base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: this.email, password: this.password }) });
    const data = await json(response); const token = valueAt(data, ["token"]);
    if (!token) throw new Error("Shiprocket authentication response was incomplete");
    return token;
  }

  private async post(path: string, payload: Record<string, unknown>, token: string) {
    return json(await this.fetcher(`${this.base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) }));
  }

  private async get(path: string, token: string) {
    return json(await this.fetcher(`${this.base}${path}`, { headers: { Authorization: `Bearer ${token}` } }));
  }

  async createShipment(request: ShipmentCreateRequest): Promise<ShipmentCreateResult> {
    const token = await this.token();
    const order = await this.post("/orders/create/adhoc", {
      order_id: request.orderId, order_date: request.createdAt, pickup_location: request.pickup.location,
      billing_customer_name: request.recipient.name, billing_last_name: "", billing_address: request.recipient.address, billing_city: request.recipient.city, billing_pincode: request.recipient.pincode, billing_state: request.recipient.state, billing_country: "India", billing_email: request.recipient.email, billing_phone: request.recipient.phone,
      shipping_is_billing: true, order_items: [{ name: request.item.name.slice(0, 120), sku: `VC-${request.orderId.slice(0, 24)}`, units: 1, selling_price: request.item.unitPrice, discount: 0, tax: 0, hsn: "000000" }], payment_method: "Prepaid", sub_total: request.item.unitPrice, length: 10, breadth: 10, height: 10, weight: 0.5,
    }, token);
    const shipmentId = valueAt(order, ["shipment_id", "shipmentId"]); if (!shipmentId) throw new Error("Shiprocket order response was incomplete");
    const assigned = await this.post("/courier/assign/awb", { shipment_id: Number(shipmentId) || shipmentId }, token);
    const awb = valueAt(assigned, ["awb_code", "awbCode", "tracking_number"]); if (!awb) throw new Error("Shiprocket AWB response was incomplete");
    return { provider: this.name, trackingNumber: awb, status: "label_created", eta: new Date(new Date(request.createdAt).getTime() + 3 * 86400000).toISOString(), message: "Shiprocket label created. Awaiting pickup.", providerShipmentId: shipmentId, awbCode: awb, courierName: valueAt(assigned, ["courier_name", "courierName"]) ?? undefined };
  }

  async advanceShipment(request: ShipmentAdvanceRequest): Promise<ShipmentAdvanceResult | null> {
    const token = await this.token();
    const tracking = await this.get(`/courier/track/awb/${encodeURIComponent(request.trackingNumber)}`, token);
    const rawStatus = valueAt(tracking, ["current_status", "status", "shipment_status"]);
    const normalized = rawStatus?.toLowerCase().replace(/[_-]/g, " ").replace(/\s+/g, " ").trim();
    const status = normalized?.includes("delivered") ? "delivered"
      : normalized?.includes("out for delivery") ? "out_for_delivery"
        : normalized?.includes("transit") ? "in_transit"
          : normalized?.includes("pick") ? "picked_up"
            : normalized?.includes("label") ? "label_created" : null;
    if (!status || status === request.currentStatus) return null;
    return { status, message: `Shiprocket tracking update: ${rawStatus ?? status}.` };
  }
}

export function shippingProvider(): ShippingProvider {
  const selected = process.env.SHIPPING_PROVIDER;
  if (selected === "shiprocket_sandbox") return new ShiprocketShippingProvider("sandbox", process.env.SHIPROCKET_SANDBOX_EMAIL ?? "", process.env.SHIPROCKET_SANDBOX_PASSWORD ?? "");
  if (selected === "shiprocket_production") return new ShiprocketShippingProvider("production", process.env.SHIPROCKET_PRODUCTION_EMAIL ?? "", process.env.SHIPROCKET_PRODUCTION_PASSWORD ?? "");
  return new LocalSandboxShippingProvider();
}
