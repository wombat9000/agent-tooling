import type { Invoice } from './billing-types';
export function computeTax(inv: Invoice): number { return Math.round(inv.cents * 0.1); }
