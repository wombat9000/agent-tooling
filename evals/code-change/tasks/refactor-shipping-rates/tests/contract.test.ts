import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateShippingQuotes, type ShipmentInput } from '../src/shipping.ts';

function shipment(overrides: Partial<ShipmentInput> = {}): ShipmentInput {
  return {
    id: 'SHP-DEFAULT',
    service: 'standard',
    weightKg: 2,
    lengthCm: 10,
    widthCm: 10,
    heightCm: 10,
    zone: 'domestic',
    declaredValueCents: 5000,
    ...overrides,
  };
}

test('returns an empty array for empty input', () => {
  assert.deepEqual(calculateShippingQuotes([]), []);
});

test('quotes economy across all zones, minimum base charge, and fragile extra transit day', () => {
  const quotes = calculateShippingQuotes([
    shipment({
      id: 'ECO-MIN',
      service: 'economy',
      weightKg: 0.4,
      lengthCm: 10,
      widthCm: 10,
      heightCm: 10,
      zone: 'domestic',
      declaredValueCents: 10000,
      fragile: false,
    }),
    shipment({
      id: 'ECO-REG-FRAGILE',
      service: 'economy',
      weightKg: 5,
      lengthCm: 50,
      widthCm: 40,
      heightCm: 30,
      zone: 'regional',
      declaredValueCents: 15000,
      fragile: true,
    }),
  ]);

  assert.deepEqual(quotes, [
    {
      id: 'ECO-MIN',
      service: 'economy',
      billableWeightKg: 1,
      baseCents: 500,
      surchargeCents: 20,
      discountCents: 0,
      totalCents: 520,
      estimatedDays: 6,
    },
    {
      id: 'ECO-REG-FRAGILE',
      service: 'economy',
      billableWeightKg: 10,
      baseCents: 1800,
      surchargeCents: 922,
      discountCents: 0,
      totalCents: 2722,
      estimatedDays: 10,
    },
  ]);

  const intl = calculateShippingQuotes([
    shipment({
      id: 'ECO-INTL',
      service: 'economy',
      weightKg: 3,
      lengthCm: 10,
      widthCm: 10,
      heightCm: 10,
      zone: 'international',
      declaredValueCents: 0,
    }),
  ]);
  assert.deepEqual(intl[0], {
    id: 'ECO-INTL',
    service: 'economy',
    billableWeightKg: 3,
    baseCents: 540,
    surchargeCents: 1422,
    discountCents: 0,
    totalCents: 1962,
    estimatedDays: 15,
  });
});

test('quotes standard service including worked example and all zones', () => {
  const [domestic] = calculateShippingQuotes([
    shipment({
      id: 'SHP-1',
      service: 'standard',
      weightKg: 4.2,
      lengthCm: 20,
      widthCm: 20,
      heightCm: 10,
      zone: 'domestic',
      declaredValueCents: 25000,
      fragile: true,
    }),
  ]);

  assert.deepEqual(domestic, {
    id: 'SHP-1',
    service: 'standard',
    billableWeightKg: 5,
    baseCents: 1300,
    surchargeCents: 878,
    discountCents: 0,
    totalCents: 2178,
    estimatedDays: 3,
  });

  const [regional, intl] = calculateShippingQuotes([
    shipment({
      id: 'STD-REG',
      service: 'standard',
      weightKg: 2,
      zone: 'regional',
      declaredValueCents: 10000,
    }),
    shipment({
      id: 'STD-INTL',
      service: 'standard',
      weightKg: 2,
      lengthCm: 30,
      widthCm: 30,
      heightCm: 20,
      zone: 'international',
      declaredValueCents: 10050,
    }),
  ]);

  assert.deepEqual(regional, {
    id: 'STD-REG',
    service: 'standard',
    billableWeightKg: 2,
    baseCents: 750,
    surchargeCents: 495,
    discountCents: 0,
    totalCents: 1245,
    estimatedDays: 5,
  });

  assert.deepEqual(intl, {
    id: 'STD-INTL',
    service: 'standard',
    billableWeightKg: 4,
    baseCents: 1040,
    surchargeCents: 1863,
    discountCents: 0,
    totalCents: 2903,
    estimatedDays: 10,
  });
});

test('quotes express service with dimensional weight divisor 4000 across zones', () => {
  const quotes = calculateShippingQuotes([
    shipment({
      id: 'EXP-DOM',
      service: 'express',
      weightKg: 1,
      lengthCm: 20,
      widthCm: 20,
      heightCm: 20,
      zone: 'domestic',
      declaredValueCents: 10000,
      fragile: true,
    }),
    shipment({
      id: 'EXP-REG',
      service: 'express',
      weightKg: 2,
      lengthCm: 40,
      widthCm: 25,
      heightCm: 20,
      zone: 'regional',
      declaredValueCents: 0,
    }),
    shipment({
      id: 'EXP-INTL',
      service: 'express',
      weightKg: 6.1,
      lengthCm: 10,
      widthCm: 10,
      heightCm: 10,
      zone: 'international',
      declaredValueCents: 30000,
      fragile: true,
    }),
  ]);

  assert.deepEqual(quotes, [
    {
      id: 'EXP-DOM',
      service: 'express',
      billableWeightKg: 2,
      baseCents: 1400,
      surchargeCents: 940,
      discountCents: 70,
      totalCents: 2270,
      estimatedDays: 1,
    },
    {
      id: 'EXP-REG',
      service: 'express',
      billableWeightKg: 5,
      baseCents: 2250,
      surchargeCents: 925,
      discountCents: 113,
      totalCents: 3062,
      estimatedDays: 2,
    },
    {
      id: 'EXP-INTL',
      service: 'express',
      billableWeightKg: 7,
      baseCents: 3150,
      surchargeCents: 4315,
      discountCents: 158,
      totalCents: 7307,
      estimatedDays: 4,
    },
  ]);
});

test('quotes freight with heavy-handling boundary at 30 kg, minimum base, and fragile extra day', () => {
  const quotes = calculateShippingQuotes([
    shipment({
      id: 'FRT-30',
      service: 'freight',
      weightKg: 30,
      lengthCm: 10,
      widthCm: 10,
      heightCm: 10,
      zone: 'domestic',
      declaredValueCents: 5000,
      fragile: false,
    }),
    shipment({
      id: 'SHP-2',
      service: 'freight',
      weightKg: 18,
      lengthCm: 60,
      widthCm: 50,
      heightCm: 55,
      zone: 'regional',
      declaredValueCents: 10000,
      fragile: true,
    }),
    shipment({
      id: 'FRT-INTL',
      service: 'freight',
      weightKg: 10,
      lengthCm: 10,
      widthCm: 10,
      heightCm: 10,
      zone: 'international',
      declaredValueCents: 100000,
      fragile: false,
    }),
  ]);

  assert.deepEqual(quotes, [
    {
      id: 'FRT-30',
      service: 'freight',
      billableWeightKg: 30,
      baseCents: 4500,
      surchargeCents: 540,
      discountCents: 225,
      totalCents: 4815,
      estimatedDays: 4,
    },
    {
      id: 'SHP-2',
      service: 'freight',
      billableWeightKg: 33,
      baseCents: 4950,
      surchargeCents: 5794,
      discountCents: 248,
      totalCents: 10496,
      estimatedDays: 8,
    },
    {
      id: 'FRT-INTL',
      service: 'freight',
      billableWeightKg: 10,
      baseCents: 4500,
      surchargeCents: 6540,
      discountCents: 225,
      totalCents: 10815,
      estimatedDays: 14,
    },
  ]);
});

test('quotes cold_chain across all zones with thermal surcharges, dim divisor 3500, and non-stackable volume discount', () => {
  const quotes = calculateShippingQuotes([
    shipment({
      id: 'COLD-DOM-MIN',
      service: 'cold_chain',
      weightKg: 2,
      lengthCm: 10,
      widthCm: 10,
      heightCm: 10,
      zone: 'domestic',
      declaredValueCents: 10000,
      fragile: false,
    }),
    shipment({
      id: 'COLD-REG-FRAGILE',
      service: 'cold_chain',
      weightKg: 5,
      lengthCm: 20,
      widthCm: 20,
      heightCm: 20,
      zone: 'regional',
      declaredValueCents: 20000,
      fragile: true,
    }),
    shipment({
      id: 'SHP-3',
      service: 'cold_chain',
      weightKg: 3.5,
      lengthCm: 40,
      widthCm: 30,
      heightCm: 20,
      zone: 'international',
      declaredValueCents: 50000,
      fragile: false,
    }),
    shipment({
      id: 'STD-MIXED-1',
      service: 'standard',
      weightKg: 4,
      lengthCm: 10,
      widthCm: 10,
      heightCm: 10,
      zone: 'domestic',
      declaredValueCents: 0,
    }),
    shipment({
      id: 'ECO-MIXED-2',
      service: 'economy',
      weightKg: 5,
      lengthCm: 10,
      widthCm: 10,
      heightCm: 10,
      zone: 'domestic',
      declaredValueCents: 0,
    }),
  ]);

  assert.deepEqual(quotes, [
    {
      id: 'COLD-DOM-MIN',
      service: 'cold_chain',
      billableWeightKg: 2,
      baseCents: 2200,
      surchargeCents: 1808,
      discountCents: 0,
      totalCents: 4008,
      estimatedDays: 1,
    },
    {
      id: 'COLD-REG-FRAGILE',
      service: 'cold_chain',
      billableWeightKg: 5,
      baseCents: 2600,
      surchargeCents: 3964,
      discountCents: 0,
      totalCents: 6564,
      estimatedDays: 2,
    },
    {
      id: 'SHP-3',
      service: 'cold_chain',
      billableWeightKg: 7,
      baseCents: 3640,
      surchargeCents: 7410,
      discountCents: 0,
      totalCents: 11050,
      estimatedDays: 4,
    },
    {
      id: 'STD-MIXED-1',
      service: 'standard',
      billableWeightKg: 4,
      baseCents: 1040,
      surchargeCents: 62,
      discountCents: 104,
      totalCents: 998,
      estimatedDays: 3,
    },
    {
      id: 'ECO-MIXED-2',
      service: 'economy',
      billableWeightKg: 5,
      baseCents: 900,
      surchargeCents: 36,
      discountCents: 90,
      totalCents: 846,
      estimatedDays: 6,
    },
  ]);
});

test('throws an error for unsupported service or zone', () => {
  assert.throws(
    () => calculateShippingQuotes([shipment({ service: 'drone' })]),
    /service/i,
  );
  assert.throws(
    () => calculateShippingQuotes([shipment({ zone: 'lunar' })]),
    /zone/i,
  );
});
