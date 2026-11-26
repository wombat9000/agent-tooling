import { forwardJsonRequest, type UpstreamConfig } from './upstream-client';

export interface BffRequest {
  readonly method: string;
  readonly authHeader: string | null;
  readonly templateId?: string;
  readonly rawBody?: string;
}

export async function handleTemplateProxy(config: UpstreamConfig, request: BffRequest) {
  if (!request.authHeader) {
    return { status: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  if (request.method === 'PATCH') {
    if (!request.templateId?.trim()) {
      return { status: 400, body: JSON.stringify({ error: 'Missing templateId' }) };
    }
    const encodedId = encodeURIComponent(request.templateId);
    return forwardJsonRequest(config, `/api/templates/${encodedId}`, {
      method: 'PATCH',
      authHeader: request.authHeader,
      body: request.rawBody,
    });
  }
  return { status: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
}
