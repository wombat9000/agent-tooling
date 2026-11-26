import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateShippingQuotes, type ShipmentInput } from '../src/shipping.ts';

function makeShipment(overrides: Partial<ShipmentInput> = {}): ShipmentInput {
  return {
    id: 'SHP-100',
    service: 'standard',
    weightKg: 3,
    lengthCm: 10,
    widthCm: 10,
    heightCm: 10,
    zone: 'domestic',
    declaredValueCents: 5000,
    ...overrides,
  };
}

test('returns empty list for empty batch', () => {
  assert.deepEqual(calculateShippingQuotes([]), []);
});

test('does not mutate caller shipment inputs', () => {
  const input = makeShipment({ weightKg: 4.2, fragile: undefined });
  const snapshot = { ...input };

  calculateShippingQuotes([input]);

  assert.deepEqual(input, snapshot);
});

test('applies standard pricing, fuel, fragile fee, and high-value insurance', () => {
  const [quote] = calculateShippingQuotes([
    makeShipment({
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

  assert.deepEqual(quote, {
    id: 'SHP-1',
    service: 'standard',
    billableWeightKg: 5,
    baseCents: 1300,
    surchargeCents: 878,
    discountCents: 0,
    totalCents: 2178,
    estimatedDays: 3,
  });
});

test('applies economy minimum base charge and fragile transit delay', () => {
  const [quote] = calculateShippingQuotes([
    makeShipment({
      id: 'ECO-1',
      service: 'economy',
      weightKg: 0.2,
      zone: 'regional',
      declaredValueCents: 10000,
      fragile: true,
    }),
  ]);

  assert.deepEqual(quote, {
    id: 'ECO-1',
    service: 'economy',
    billableWeightKg: 1,
    baseCents: 500,
    surchargeCents: 770,
    discountCents: 0,
    totalCents: 1270,
    estimatedDays: 10,
  });
});

test('uses express dimensional divisor of 4000 when dimensional weight exceeds actual weight', () => {
  const [quote] = calculateShippingQuotes([
    makeShipment({
      id: 'EXP-DIM',
      service: 'express',
      weightKg: 2,
      lengthCm: 40,
      widthCm: 25,
      heightCm: 20,
      zone: 'international',
      declaredValueCents: 0,
    }),
  ]);

  assert.deepEqual(quote, {
    id: 'EXP-DIM',
    service: 'express',
    billableWeightKg: 5,
    baseCents: 2250,
    surchargeCents: 3025,
    discountCents: 0,
    totalCents: 5275,
    estimatedDays: 4,
  });
});

test('adds freight heavy-handling surcharge only above 30 kg and adds fragile transit day', () => {
  const [atThreshold, aboveThreshold] = calculateShippingQuotes([
    makeShipment({
      id: 'FRT-30',
      service: 'freight',
      weightKg: 30,
      zone: 'domestic',
      declaredValueCents: 0,
    }),
    makeShipment({
      id: 'FRT-33',
      service: 'freight',
      weightKg: 18,
      lengthCm: 60,
      widthCm: 50,
      heightCm: 55,
      zone: 'regional',
      declaredValueCents: 10000,
      fragile: true,
    }),
  ]);

  assert.equal(atThreshold.surchargeCents, 540);
  assert.equal(atThreshold.estimatedDays, 4);
  assert.equal(aboveThreshold.billableWeightKg, 33);
  assert.equal(aboveThreshold.surchargeCents, 5794);
  assert.equal(aboveThreshold.estimatedDays, 8);
});

test('quotes cold_chain with thermal surcharges and excludes cold_chain from batch discounts', () => {
  const batch = [
    makeShipment({
      id: 'COLD-DOM',
      service: 'cold_chain',
      weightKg: 1,
      zone: 'domestic',
      declaredValueCents: 0,
    }),
    makeShipment({
      id: 'COLD-INTL',
      service: 'cold_chain',
      weightKg: 3.5,
      lengthCm: 40,
      widthCm: 30,
      heightCm: 20,
      zone: 'international',
      declaredValueCents: 50000,
      fragile: false,
    }),
    makeShipment({ id: 'STD-1', service: 'standard', weightKg: 4, zone: 'domestic', declaredValueCents: 0 }),
    makeShipment({ id: 'STD-2', service: 'standard', weightKg: 4, zone: 'domestic', declaredValueCents: 0 }),
    makeShipment({ id: 'STD-3', service: 'standard', weightKg: 4, zone: 'domestic', declaredValueCents: 0 }),
  ];

  const quotes = calculateShippingQuotes(batch);

  assert.equal(quotes[0].discountCents, 0);
  assert.equal(quotes[0].surchargeCents, 1808);
  assert.equal(quotes[0].estimatedDays, 1);

  assert.deepEqual(quotes[1], {
    id: 'COLD-INTL',
    service: 'cold_chain',
    billableWeightKg: 7,
    baseCents: 3640,
    surchargeCents: 7410,
    discountCents: 0,
    totalCents: 11050,
    estimatedDays: 4,
  });

  assert.equal(quotes[2].discountCents, 104);
});

test('rejects unsupported shipping services and zones', () => {
  assert.throws(
    () => calculateShippingQuotes([makeShipment({ service: 'overnight' })]),
    /Unsupported shipping service/,
  );
  assert.throws(
    () => calculateShippingQuotes([makeShipment({ zone: 'antarctica' })]),
    /Unsupported shipping zone/,
  );
});
