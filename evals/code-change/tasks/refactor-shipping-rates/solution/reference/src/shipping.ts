import { policyForService, type ServicePolicy } from './service-policy.ts';
import {
  calculateBillableWeightKg,
  createShipment,
  type Shipment,
  type ShipmentInput,
} from './shipment.ts';

export type { ShipmentInput };

export interface ShipmentQuote {
  id: string;
  service: string;
  billableWeightKg: number;
  baseCents: number;
  surchargeCents: number;
  discountCents: number;
  totalCents: number;
  estimatedDays: number;
}

interface PricingContext {
  readonly shipment: Shipment;
  readonly policy: ServicePolicy;
  readonly billableWeightKg: number;
  readonly baseCents: number;
}

const INSURANCE_INCLUDED_LIMIT_CENTS = 10_000;
const INSURANCE_RATE_PERCENT = 2;
const SMALL_BATCH_MIN_SHIPMENTS = 3;
const SMALL_BATCH_DISCOUNT_PERCENT = 5;
const LARGE_BATCH_MIN_SHIPMENTS = 5;
const LARGE_BATCH_DISCOUNT_PERCENT = 10;
const FRAGILE_EXTRA_TRANSIT_DAYS = 1;

function roundPercentOfCents(amountCents: number, percent: number): number {
  return Math.round((amountCents * percent) / 100);
}

function calculateBaseCents(billableWeightKg: number, policy: ServicePolicy): number {
  return Math.max(policy.minimumBaseCents, billableWeightKg * policy.ratePerKgCents);
}

function calculateInsuranceCents(declaredValueCents: number): number {
  const insurableExcessCents = declaredValueCents - INSURANCE_INCLUDED_LIMIT_CENTS;
  if (insurableExcessCents <= 0) {
    return 0;
  }
  return roundPercentOfCents(insurableExcessCents, INSURANCE_RATE_PERCENT);
}

function calculateServiceSpecificSurchargeCents(context: PricingContext): number {
  const { shipment, policy, billableWeightKg } = context;
  const heavySurchargeCents =
    policy.heavyHandling !== null && billableWeightKg > policy.heavyHandling.weightThresholdKg
      ? policy.heavyHandling.surchargeCents
      : 0;
  const thermalSurchargeCents =
    policy.thermalPackagingCentsByZone !== null
      ? policy.thermalPackagingCentsByZone[shipment.zone]
      : 0;
  return heavySurchargeCents + thermalSurchargeCents;
}

function calculateSurchargeCents(context: PricingContext): number {
  const { shipment, policy, baseCents } = context;
  const zoneSurchargeCents = policy.zoneSurchargeCents[shipment.zone];
  const fuelSurchargeCents = roundPercentOfCents(baseCents, policy.fuelSurchargePercent);
  const fragileSurchargeCents = shipment.fragile ? policy.fragileSurchargeCents : 0;
  const insuranceSurchargeCents = calculateInsuranceCents(shipment.declaredValueCents);
  const serviceSpecificCents = calculateServiceSpecificSurchargeCents(context);
  return (
    zoneSurchargeCents +
    fuelSurchargeCents +
    fragileSurchargeCents +
    insuranceSurchargeCents +
    serviceSpecificCents
  );
}

function resolveBatchDiscountPercent(batchSize: number): number {
  if (batchSize >= LARGE_BATCH_MIN_SHIPMENTS) {
    return LARGE_BATCH_DISCOUNT_PERCENT;
  }
  if (batchSize >= SMALL_BATCH_MIN_SHIPMENTS) {
    return SMALL_BATCH_DISCOUNT_PERCENT;
  }
  return 0;
}

function calculateVolumeDiscountCents(context: PricingContext, batchSize: number): number {
  if (!context.policy.eligibleForVolumeDiscount) {
    return 0;
  }
  const discountPercent = resolveBatchDiscountPercent(batchSize);
  return discountPercent > 0 ? roundPercentOfCents(context.baseCents, discountPercent) : 0;
}

function calculateEstimatedDays(shipment: Shipment, policy: ServicePolicy): number {
  const baseDays = policy.transitDaysByZone[shipment.zone];
  const extraDays = shipment.fragile && policy.fragileAddsTransitDay ? FRAGILE_EXTRA_TRANSIT_DAYS : 0;
  return baseDays + extraDays;
}

function quoteShipment(shipment: Shipment, batchSize: number): ShipmentQuote {
  const policy = policyForService(shipment.service);
  const billableWeightKg = calculateBillableWeightKg(shipment, policy.dimensionalDivisorCm3PerKg);
  const baseCents = calculateBaseCents(billableWeightKg, policy);
  const context: PricingContext = { shipment, policy, billableWeightKg, baseCents };
  const surchargeCents = calculateSurchargeCents(context);
  const discountCents = calculateVolumeDiscountCents(context, batchSize);
  const estimatedDays = calculateEstimatedDays(shipment, policy);

  return {
    id: shipment.id,
    service: shipment.service,
    billableWeightKg,
    baseCents,
    surchargeCents,
    discountCents,
    totalCents: baseCents + surchargeCents - discountCents,
    estimatedDays,
  };
}

export function calculateShippingQuotes(shipments: ShipmentInput[]): ShipmentQuote[] {
  const batchSize = shipments.length;
  return shipments.map((input) => quoteShipment(createShipment(input), batchSize));
}
