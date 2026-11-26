export type ShippingQuoteInput = [string, number, string, boolean, boolean, boolean];

export function quoteShipping(
  input: ShippingQuoteInput,
  tier: string,
  zone: number,
): [number, string, boolean] {
  const [, weightGrams, speed, isFragile, requiresSignature, isColdChain] = input;
  let base = 499;
  if (speed === 'overnight_air') {
    base = 2499;
  } else if (speed === 'two_day') {
    base = 1299;
  } else if (speed === 'ground_std') {
    base = 599;
  }

  if (zone === 3) base += 650;
  else if (zone === 4) base += 1125;
  else if (zone === 5) base += 1875;

  if (weightGrams > 5000) base += Math.ceil((weightGrams - 5000) / 500) * 145;
  if (isFragile) base += 350;
  if (requiresSignature) base += 275;
  if (isColdChain) base += 920;

  if (tier === 'vip_gold') base = Math.round(base * 0.75);
  else if (tier === 'vip_silver') base = Math.round(base * 0.9);

  const label = speed === 'overnight_air' ? 'EXP' : speed === 'two_day' ? 'PRI' : 'STD';
  return [base, label, isColdChain || (isFragile && requiresSignature)];
}
