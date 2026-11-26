import { saveInvoice } from './billing-db';
import { computeTax } from './billing-tax';
import type { Invoice } from './billing-types';
export function finalizeInvoice(inv: Invoice): number { saveInvoice(inv); return computeTax(inv); }
