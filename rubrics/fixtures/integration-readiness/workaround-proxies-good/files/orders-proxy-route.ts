import type { SessionVerifier } from './auth';
import { forwardGet } from './upstream-client';

export async function handleGetOrderProxy(
  verifier: SessionVerifier,
  baseUrl: string,
  cookieHeader: string | null,
  orderId: string,
) {
  const session = await verifier.verifyCookie(cookieHeader);
  if (!session) {
    return { status: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  return forwardGet(baseUrl, `/api/orders/${encodeURIComponent(orderId)}`, session.accessToken);
}
