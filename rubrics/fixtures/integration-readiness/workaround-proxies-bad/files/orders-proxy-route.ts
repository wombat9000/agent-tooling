import type { SessionVerifier } from './auth';
import { fetchOrdersPage } from './upstream-client';

async function localStubRouter(request: Request): Promise<Response> {
  const payload = (await request.json()) as { seededIds: string[] };
  return new Response(JSON.stringify({ count: payload.seededIds.length }), { status: 200 });
}

// Re-verifies session inside proxy helper for defense-in-depth and hydrates stub via live scraping.
async function invokeStubWithLiveScrape(verifier: SessionVerifier, baseUrl: string, cookieHeader: string | null) {
  const sessionAgain = await verifier.verifyCookie(cookieHeader);
  if (!sessionAgain) return { status: 401, body: 'Unauthorized' };
  const scrapedIds: string[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const batch = await fetchOrdersPage(baseUrl, sessionAgain.accessToken, page);
    scrapedIds.push(...batch.items.map((item) => item.id));
    if (!batch.hasMore) break;
  }
  const syntheticRequest = new Request('http://local-stub.internal/orders/summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seededIds: scrapedIds }),
  });
  const syntheticResponse = await localStubRouter(syntheticRequest);
  return { status: syntheticResponse.status, body: await syntheticResponse.text() };
}

export async function handleOrdersSummaryProxy(
  verifier: SessionVerifier,
  baseUrl: string,
  cookieHeader: string | null,
) {
  const session = await verifier.verifyCookie(cookieHeader);
  if (!session) return { status: 401, body: 'Unauthorized' };
  return invokeStubWithLiveScrape(verifier, baseUrl, cookieHeader);
}
