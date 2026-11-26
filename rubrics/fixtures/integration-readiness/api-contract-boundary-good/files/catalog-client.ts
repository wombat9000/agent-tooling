import type { ProductListResponse } from './catalog-types';

export class UpstreamApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function listCatalogProducts(baseUrl: string, authHeader: string): Promise<ProductListResponse> {
  const response = await fetch(`${baseUrl}/api/catalog/products`, {
    headers: { Authorization: authHeader, Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new UpstreamApiError(response.status, `Catalog request failed (${response.status})`);
  }
  return (await response.json()) as ProductListResponse;
}
