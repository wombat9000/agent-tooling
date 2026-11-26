export function createShipment(
  orderId: string,
  recipientName: string,
  street: string,
  city: string,
  postalCode: string,
  countryCode: string,
  weightGrams: number,
  declaredValueCents: number,
  requireSignature: boolean = false,
  fragile: boolean = false,
  expedite: boolean = false,
): string {
  const rate = estimateShippingCents(street, city, postalCode, countryCode, weightGrams, expedite);
  const label = formatDestinationLine(street, city, postalCode, countryCode);
  return `${orderId}:${recipientName}:${label}:${rate}:${declaredValueCents}:${requireSignature}:${fragile}`;
}

export function estimateShippingCents(
  street: string,
  city: string,
  postalCode: string,
  countryCode: string,
  weightGrams: number,
  expedite: boolean = false,
): number {
  const base = countryCode === 'US' ? 500 : 1800;
  const urbanSurcharge = city.length > 0 && street.length > 0 && postalCode.length > 0 ? 100 : 0;
  return base + urbanSurcharge + Math.ceil(weightGrams / 500) * 150 + (expedite ? 1200 : 0);
}

export function formatDestinationLine(
  street: string,
  city: string,
  postalCode: string,
  countryCode: string,
): string {
  return `${street}, ${city} ${postalCode}, ${countryCode}`;
}
