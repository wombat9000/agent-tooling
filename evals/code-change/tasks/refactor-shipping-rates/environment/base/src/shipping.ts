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

export function calculateShippingQuotes(shipments: ShipmentInput[]): ShipmentQuote[] {
  const out: ShipmentQuote[] = [];
  const n = shipments.length;

  for (let i = 0; i < n; i++) {
    const s = shipments[i];
    // Section 1: dimensional weight and billable weight
    let div = 5000;
    if (s.service === 'economy') {
      div = 6000;
    } else if (s.service === 'standard') {
      div = 5000;
    } else if (s.service === 'express') {
      div = 4000;
    } else if (s.service === 'freight') {
      div = 5000;
    } else {
      throw new Error('Unsupported shipping service: ' + s.service);
    }

    const dw = (s.lengthCm * s.widthCm * s.heightCm) / div;
    let bw = Math.ceil(s.weightKg > dw ? s.weightKg : dw);
    if (bw < 1) {
      bw = 1;
    }
    s.weightKg = bw;
    s.fragile = Boolean(s.fragile);

    // Section 2: base rate and fuel calculation
    let bc = 0;
    let fuel = 0;
    if (s.service === 'economy') {
      bc = bw * 180;
      if (bc < 500) bc = 500;
      fuel = Math.round((bc * 4) / 100);
    } else if (s.service === 'standard') {
      bc = bw * 260;
      if (bc < 750) bc = 750;
      fuel = Math.round((bc * 6) / 100);
    } else if (s.service === 'express') {
      bc = bw * 450;
      if (bc < 1400) bc = 1400;
      fuel = Math.round((bc * 10) / 100);
    } else if (s.service === 'freight') {
      bc = bw * 150;
      if (bc < 4500) bc = 4500;
      fuel = Math.round((bc * 12) / 100);
    }

    // Section 3: zone charges, fragile fees, transit days, insurance, and discounts
    let zc = 0;
    let td = 0;
    let sc = fuel;
    if (s.service === 'economy') {
      if (s.zone === 'domestic') {
        zc = 0;
        td = 6;
      } else if (s.zone === 'regional') {
        zc = 350;
        td = 9;
      } else if (s.zone === 'international') {
        zc = 1400;
        td = 15;
      } else {
        throw new Error('Unsupported shipping zone: ' + s.zone);
      }
      if (s.fragile) {
        sc += 400;
        td += 1;
      }
    } else if (s.service === 'standard') {
      if (s.zone === 'domestic') {
        zc = 0;
        td = 3;
      } else if (s.zone === 'regional') {
        zc = 450;
        td = 5;
      } else if (s.zone === 'international') {
        zc = 1800;
        td = 10;
      } else {
        throw new Error('Unsupported shipping zone: ' + s.zone);
      }
      if (s.fragile) {
        sc += 500;
      }
    } else if (s.service === 'express') {
      if (s.zone === 'domestic') {
        zc = 0;
        td = 1;
      } else if (s.zone === 'regional') {
        zc = 700;
        td = 2;
      } else if (s.zone === 'international') {
        zc = 2800;
        td = 4;
      } else {
        throw new Error('Unsupported shipping zone: ' + s.zone);
      }
      if (s.fragile) {
        sc += 800;
      }
    } else if (s.service === 'freight') {
      if (s.zone === 'domestic') {
        zc = 0;
        td = 4;
      } else if (s.zone === 'regional') {
        zc = 1500;
        td = 7;
      } else if (s.zone === 'international') {
        zc = 4200;
        td = 14;
      } else {
        throw new Error('Unsupported shipping zone: ' + s.zone);
      }
      if (bw > 30) {
        sc += 2500;
      }
      if (s.fragile) {
        sc += 1200;
        td += 1;
      }
    }

    sc += zc;
    if (s.declaredValueCents > 10000) {
      sc += Math.round(((s.declaredValueCents - 10000) * 2) / 100);
    }

    let dc = 0;
    if (n >= 5) {
      dc = Math.round((bc * 10) / 100);
    } else if (n >= 3) {
      dc = Math.round((bc * 5) / 100);
    }

    out.push({
      id: s.id,
      service: s.service,
      billableWeightKg: bw,
      baseCents: bc,
      surchargeCents: sc,
      discountCents: dc,
      totalCents: bc + sc - dc,
      estimatedDays: td,
    });
  }

  return out;
}
