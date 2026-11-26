# Shipping Rate Calculator Refactoring

Refactor the legacy shipping quote calculator in `src/shipping.ts` and add support for the **`cold_chain`** service tier.

## Public API

Keep `src/shipping.ts` exporting the following public types and function:

```ts
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

export function calculateShippingQuotes(shipments: ShipmentInput[]): ShipmentQuote[];
```

- Callers read the returned `ShipmentQuote[]` in input order (`[]` returns `[]`); they do not rely on any mutation of the input `shipments` array or its objects.
- Throw an `Error` if a shipment specifies an unsupported `service` or `zone`.

## Pricing and Transit Rules

Supported zones are `'domestic'`, `'regional'`, and `'international'`.
Supported services are `'economy'`, `'standard'`, `'express'`, `'freight'`, and the new **`'cold_chain'`** tier.

All monetary values are integer cents. Perform rounding with `Math.round(...)` at each individual step specified below.

### 1. Service Tier Table

| Service | Dim Divisor (`cm³ / kg`) | Rate per kg (cents) | Min Base (cents) | Zone Surcharge (`dom` / `reg` / `intl`, cents) | Fuel Rate (% of `baseCents`) | Fragile Fee (cents) | Base Transit Days (`dom` / `reg` / `intl`) |
|---|---:|---:|---:|---|---:|---:|---|
| `economy` | `6000` | `180` | `500` | `0` / `350` / `1400` | `4%` | `400` | `6` / `9` / `15` |
| `standard` | `5000` | `260` | `750` | `0` / `450` / `1800` | `6%` | `500` | `3` / `5` / `10` |
| `express` | `4000` | `450` | `1400` | `0` / `700` / `2800` | `10%` | `800` | `1` / `2` / `4` |
| `freight` | `5000` | `150` | `4500` | `0` / `1500` / `4200` | `12%` | `1200` | `4` / `7` / `14` |
| `cold_chain` *(new)* | `3500` | `520` | `2200` | `0` / `900` / `3600` | `14%` | `1000` | `1` / `2` / `4` |

### 2. Billable Weight (`billableWeightKg`)

- Compute dimensional weight: `dimensionalWeightKg = (lengthCm * widthCm * heightCm) / divisor`.
- Round up to whole kilograms with a minimum of `1` kg:
  `billableWeightKg = Math.max(1, Math.ceil(Math.max(weightKg, dimensionalWeightKg)))`.

### 3. Base Charge (`baseCents`)

- `baseCents = Math.max(minBaseCents, billableWeightKg * ratePerKgCents)`.

### 4. Surcharges (`surchargeCents`)

Sum the following integer-cent components:

1. **Zone surcharge:** from the table above.
2. **Fuel surcharge:** `Math.round(baseCents * fuelPercent / 100)`.
3. **Fragile handling:** when `fragile === true`, add the service's fragile fee from the table; otherwise `0`.
4. **Declared-value insurance:** when `declaredValueCents > 10000`, add `Math.round((declaredValueCents - 10000) * 2 / 100)`; otherwise `0`.
5. **Service-specific surcharges:**
   - **`freight`:** when `billableWeightKg > 30`, add `2500` cents heavy-handling surcharge.
   - **`cold_chain`:** add `1500` cents thermal-packaging surcharge for `'domestic'` and `'regional'`, or `2500` cents for `'international'` (`1500` base thermal + `1000` international dry-ice/customs handling).

### 5. Volume Discount (`discountCents`)

- Applies to `'economy'`, `'standard'`, `'express'`, and `'freight'` based on total batch size `shipments.length`:
  - `shipments.length >= 5`: `Math.round(baseCents * 10 / 100)` (`10%` of `baseCents`).
  - `3 <= shipments.length <= 4`: `Math.round(baseCents * 5 / 100)` (`5%` of `baseCents`).
  - `shipments.length < 3`: `0`.
- **`cold_chain` (non-stackable):** `cold_chain` shipments always have `discountCents = 0`, regardless of batch size. (In a mixed batch, `cold_chain` items still count toward `shipments.length` for other eligible shipments.)

### 6. Total (`totalCents`) and Transit Days (`estimatedDays`)

- `totalCents = baseCents + surchargeCents - discountCents`.
- Start from the service's base transit days for the shipment's zone.
- When `fragile === true` and `service` is `'economy'` or `'freight'`, add `+1` day. Fragile handling does not add transit days for `'standard'`, `'express'`, or `'cold_chain'`.

## Worked Examples

1. **Standard domestic, fragile, high value (batch of 1):**
   - Input: `{ id: 'SHP-1', service: 'standard', weightKg: 4.2, lengthCm: 20, widthCm: 20, heightCm: 10, zone: 'domestic', declaredValueCents: 25000, fragile: true }`
   - `dimWeight = 0.8`, `billableWeightKg = 5`, `baseCents = 1300`.
   - `surchargeCents = 0 (zone) + 78 (fuel) + 500 (fragile) + 300 (insurance) = 878`.
   - `discountCents = 0`, `totalCents = 2178`, `estimatedDays = 3`.

2. **Freight regional, dimensional crossover, heavy, fragile (batch of 3):**
   - Input: `{ id: 'SHP-2', service: 'freight', weightKg: 18, lengthCm: 60, widthCm: 50, heightCm: 55, zone: 'regional', declaredValueCents: 10000, fragile: true }`
   - `dimWeight = 33`, `billableWeightKg = 33`, `baseCents = 4950`.
   - `surchargeCents = 1500 (zone) + 594 (fuel) + 1200 (fragile) + 0 (insurance) + 2500 (heavy) = 5794`.
   - `discountCents = Math.round(4950 * 5 / 100) = 248`, `totalCents = 10496`, `estimatedDays = 8`.

3. **Cold chain international, dimensional crossover (batch of 5):**
   - Input: `{ id: 'SHP-3', service: 'cold_chain', weightKg: 3.5, lengthCm: 40, widthCm: 30, heightCm: 20, zone: 'international', declaredValueCents: 50000, fragile: false }`
   - `dimWeight = 24000 / 3500 = 6.857...`, `billableWeightKg = 7`, `baseCents = 3640`.
   - `surchargeCents = 3600 (zone) + 510 (fuel) + 0 (fragile) + 800 (insurance) + 2500 (thermal) = 7410`.
   - `discountCents = 0`, `totalCents = 11050`, `estimatedDays = 4`.

## Tests and Verification

- Keep production code under `src/` and add thorough unit tests under `tests/` using Node's built-in test runner (`node:test` and `node:assert/strict`) covering all service tiers, zones, weight crossovers, surcharges, volume-discount rules, and edge cases.
- Verify with `pnpm typecheck` and `pnpm test`.
