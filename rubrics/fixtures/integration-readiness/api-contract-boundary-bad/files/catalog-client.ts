export function fetchRawCatalogResponse(baseUrl: string, authHeader: string): Promise<Response> {
  return fetch(`${baseUrl}/api/catalog/products`, {
    headers: { Authorization: authHeader, Accept: 'application/json' },
  });
}
