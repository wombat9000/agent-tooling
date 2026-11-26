import type { Order } from './types';

export function buildTaxInvoiceSummary(order: Order) {
  const countryCode = order.getCustomer().getAccount().getBillingProfile().getPrimaryAddress().getCountry().getCode();
  const postalCode = order.getCustomer().getAccount().getBillingProfile().getPrimaryAddress().getPostalCode();
  const taxRate = order.getCustomer().getAccount().getBillingProfile().getPrimaryAddress().getCountry().getTaxRule().getRate();
  const regionCode = order.getCustomer().getAccount().getBillingProfile().getPrimaryAddress().getCountry().getTaxRule().getRegionCode();
  const currency = order.getCustomer().getAccount().getBillingProfile().getCurrencyCode();
  const taxCents = Math.round(order.getSubtotalCents() * taxRate);

  return {
    orderId: order.getId(),
    countryCode,
    postalCode,
    regionCode,
    currency,
    taxCents,
  };
}
