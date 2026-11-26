export type ServiceTier = 'economy' | 'standard' | 'express' | 'freight' | 'cold_chain';
export type ShippingZone = 'domestic' | 'regional' | 'international';

export interface HeavyHandlingRule {
  readonly weightThresholdKg: number;
  readonly surchargeCents: number;
}

export interface ServicePolicy {
  readonly dimensionalDivisorCm3PerKg: number;
  readonly ratePerKgCents: number;
  readonly minimumBaseCents: number;
  readonly fuelSurchargePercent: number;
  readonly fragileSurchargeCents: number;
  readonly fragileAddsTransitDay: boolean;
  readonly eligibleForVolumeDiscount: boolean;
  readonly zoneSurchargeCents: Readonly<Record<ShippingZone, number>>;
  readonly transitDaysByZone: Readonly<Record<ShippingZone, number>>;
  readonly heavyHandling: HeavyHandlingRule | null;
  readonly thermalPackagingCentsByZone: Readonly<Record<ShippingZone, number>> | null;
}

const SERVICE_POLICIES: Readonly<Record<ServiceTier, ServicePolicy>> = {
  economy: {
    dimensionalDivisorCm3PerKg: 6000,
    ratePerKgCents: 180,
    minimumBaseCents: 500,
    fuelSurchargePercent: 4,
    fragileSurchargeCents: 400,
    fragileAddsTransitDay: true,
    eligibleForVolumeDiscount: true,
    zoneSurchargeCents: { domestic: 0, regional: 350, international: 1400 },
    transitDaysByZone: { domestic: 6, regional: 9, international: 15 },
    heavyHandling: null,
    thermalPackagingCentsByZone: null,
  },
  standard: {
    dimensionalDivisorCm3PerKg: 5000,
    ratePerKgCents: 260,
    minimumBaseCents: 750,
    fuelSurchargePercent: 6,
    fragileSurchargeCents: 500,
    fragileAddsTransitDay: false,
    eligibleForVolumeDiscount: true,
    zoneSurchargeCents: { domestic: 0, regional: 450, international: 1800 },
    transitDaysByZone: { domestic: 3, regional: 5, international: 10 },
    heavyHandling: null,
    thermalPackagingCentsByZone: null,
  },
  express: {
    dimensionalDivisorCm3PerKg: 4000,
    ratePerKgCents: 450,
    minimumBaseCents: 1400,
    fuelSurchargePercent: 10,
    fragileSurchargeCents: 800,
    fragileAddsTransitDay: false,
    eligibleForVolumeDiscount: true,
    zoneSurchargeCents: { domestic: 0, regional: 700, international: 2800 },
    transitDaysByZone: { domestic: 1, regional: 2, international: 4 },
    heavyHandling: null,
    thermalPackagingCentsByZone: null,
  },
  freight: {
    dimensionalDivisorCm3PerKg: 5000,
    ratePerKgCents: 150,
    minimumBaseCents: 4500,
    fuelSurchargePercent: 12,
    fragileSurchargeCents: 1200,
    fragileAddsTransitDay: true,
    eligibleForVolumeDiscount: true,
    zoneSurchargeCents: { domestic: 0, regional: 1500, international: 4200 },
    transitDaysByZone: { domestic: 4, regional: 7, international: 14 },
    heavyHandling: { weightThresholdKg: 30, surchargeCents: 2500 },
    thermalPackagingCentsByZone: null,
  },
  cold_chain: {
    dimensionalDivisorCm3PerKg: 3500,
    ratePerKgCents: 520,
    minimumBaseCents: 2200,
    fuelSurchargePercent: 14,
    fragileSurchargeCents: 1000,
    fragileAddsTransitDay: false,
    eligibleForVolumeDiscount: false,
    zoneSurchargeCents: { domestic: 0, regional: 900, international: 3600 },
    transitDaysByZone: { domestic: 1, regional: 2, international: 4 },
    heavyHandling: null,
    thermalPackagingCentsByZone: { domestic: 1500, regional: 1500, international: 2500 },
  },
};

export function parseServiceTier(value: string): ServiceTier {
  if (!Object.hasOwn(SERVICE_POLICIES, value)) {
    throw new Error(`Unsupported shipping service: ${value}`);
  }
  return value as ServiceTier;
}

export function parseShippingZone(value: string): ShippingZone {
  if (!Object.hasOwn(SERVICE_POLICIES.standard.zoneSurchargeCents, value)) {
    throw new Error(`Unsupported shipping zone: ${value}`);
  }
  return value as ShippingZone;
}

export function policyForService(service: ServiceTier): ServicePolicy {
  return SERVICE_POLICIES[service];
}
