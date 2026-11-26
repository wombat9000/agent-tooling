import {
  parseServiceTier,
  parseShippingZone,
  type ServiceTier,
  type ShippingZone,
} from './service-policy.ts';

export interface ParcelDimensions {
  readonly lengthCm: number;
  readonly widthCm: number;
  readonly heightCm: number;
}

export interface Shipment {
  readonly id: string;
  readonly service: ServiceTier;
  readonly zone: ShippingZone;
  readonly weightKg: number;
  readonly dimensions: ParcelDimensions;
  readonly declaredValueCents: number;
  readonly fragile: boolean;
}

export interface ShipmentInput {
  id: string;
  service: string;
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  zone: string;
  declaredValueCents: number;
  fragile?: boolean;
}

const MINIMUM_BILLABLE_WEIGHT_KG = 1;

function assertNonNegativeFinite(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`Shipment ${fieldName} must be a non-negative finite number`);
  }
  return value;
}

export function createShipment(input: ShipmentInput): Shipment {
  return {
    id: input.id,
    service: parseServiceTier(input.service),
    zone: parseShippingZone(input.zone),
    weightKg: assertNonNegativeFinite(input.weightKg, 'weightKg'),
    dimensions: {
      lengthCm: assertNonNegativeFinite(input.lengthCm, 'lengthCm'),
      widthCm: assertNonNegativeFinite(input.widthCm, 'widthCm'),
      heightCm: assertNonNegativeFinite(input.heightCm, 'heightCm'),
    },
    declaredValueCents: assertNonNegativeFinite(input.declaredValueCents, 'declaredValueCents'),
    fragile: input.fragile === true,
  };
}

export function calculateBillableWeightKg(
  shipment: Shipment,
  dimensionalDivisorCm3PerKg: number,
): number {
  const { lengthCm, widthCm, heightCm } = shipment.dimensions;
  const dimensionalWeightKg = (lengthCm * widthCm * heightCm) / dimensionalDivisorCm3PerKg;
  const chargeableWeightKg = Math.max(shipment.weightKg, dimensionalWeightKg);
  return Math.max(MINIMUM_BILLABLE_WEIGHT_KG, Math.ceil(chargeableWeightKg));
}
