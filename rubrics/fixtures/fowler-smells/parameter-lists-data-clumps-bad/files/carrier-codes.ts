export type CarrierCode = 'ground' | 'air' | 'freight';

export function isDomesticCountry(countryCode: string): boolean {
  return countryCode.toUpperCase() === 'US';
}
