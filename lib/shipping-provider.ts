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

export function shippingProvider(): ShippingProvider {
  return new LocalSandboxShippingProvider();
}
