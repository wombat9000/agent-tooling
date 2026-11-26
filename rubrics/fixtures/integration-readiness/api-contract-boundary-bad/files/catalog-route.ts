import { fetchRawCatalogResponse } from './catalog-client';
import type { ProductSummary } from './catalog-types';

export async function handleListCatalog(baseUrl: string, authHeader: string) {
  const rawResponse = await fetchRawCatalogResponse(baseUrl, authHeader);
  const parsed = (await rawResponse.json()) as { items?: ProductSummary[] };
  const items = (parsed.items ?? []).filter((item) => !item.isDemo);
  return { status: rawResponse.status, body: { items } };
}
