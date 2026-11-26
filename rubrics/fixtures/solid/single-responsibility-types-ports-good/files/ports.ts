import type { ShipmentOrder } from './types';

export interface ShipmentRepository {
  findById(shipmentId: string): Promise<ShipmentOrder | null>;
  save(shipment: ShipmentOrder): Promise<void>;
}

export interface Clock {
  nowIso(): string;
}

export interface ShipmentNotifier {
  notifyDispatched(shipmentId: string, destinationCode: string): Promise<void>;
}
