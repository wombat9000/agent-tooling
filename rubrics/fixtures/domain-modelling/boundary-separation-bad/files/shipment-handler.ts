import { calculateShipmentFromQuery } from './shipment-policy';

export function handleQuoteRequest(rawQueryString: string) {
  return calculateShipmentFromQuery(rawQueryString);
}
