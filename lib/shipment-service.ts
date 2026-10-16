import type { ShipmentAdvanceResult, ShipmentCreateRequest, ShippingProvider } from "./shipping-provider";

export type StoredShipment = {
  id: string;
  orderId: string;
  provider: string;
  trackingNumber: string;
  status: string;
  eta: string;
  shiprocketShipmentId?: string | null;
  awbCode?: string | null;
  courierName?: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function createShipmentRecord(
  orderId: string,
  request: ShipmentCreateRequest,
  provider: ShippingProvider,
): Promise<{ shipment: StoredShipment; event: { status: string; message: string; occurredAt: string } }> {
  const result = await provider.createShipment(request);
  return {
    shipment: {
      id: crypto.randomUUID(),
      orderId,
      provider: result.provider,
      trackingNumber: result.trackingNumber,
      status: result.status,
      eta: result.eta,
      shiprocketShipmentId: result.providerShipmentId,
      awbCode: result.awbCode,
      courierName: result.courierName,
      createdAt: request.createdAt,
      updatedAt: request.createdAt,
    },
    event: { status: result.status, message: result.message, occurredAt: request.createdAt },
  };
}

export async function advanceShipmentRecord(
  shipment: StoredShipment,
  occurredAt: string,
  provider: ShippingProvider,
): Promise<{ shipment: StoredShipment; event: { status: string; message: string; occurredAt: string } } | null> {
  const result: ShipmentAdvanceResult | null = await provider.advanceShipment({ trackingNumber: shipment.trackingNumber, currentStatus: shipment.status, occurredAt });
  if (!result) return null;
  return {
    shipment: { ...shipment, status: result.status, updatedAt: occurredAt },
    event: { status: result.status, message: result.message, occurredAt },
  };
}
