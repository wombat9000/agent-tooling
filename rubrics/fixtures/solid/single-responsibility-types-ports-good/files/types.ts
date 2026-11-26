export type ShipmentStatus = 'pending' | 'dispatched' | 'delivered';

export interface ParcelSpec {
  readonly sku: string;
  readonly weightGrams: number;
}

export interface ShipmentOrder {
  readonly id: string;
  readonly destinationCode: string;
  readonly parcels: readonly ParcelSpec[];
  readonly status: ShipmentStatus;
  readonly dispatchedAtIso: string | null;
}
