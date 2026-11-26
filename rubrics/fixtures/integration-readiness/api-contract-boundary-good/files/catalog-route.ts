import { listCatalogProducts, UpstreamApiError } from './catalog-client';

export async function handleListCatalog(baseUrl: string, authHeader: string) {
  try {
    const payload = await listCatalogProducts(baseUrl, authHeader);
    return { status: 200, body: payload };
  } catch (error) {
    if (error instanceof UpstreamApiError) {
      return { status: error.status, body: { error: error.message } };
    }
    return { status: 502, body: { error: 'Upstream unavailable' } };
  }
}
