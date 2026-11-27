import { forwardUpstreamResponse } from './api-forward';

export interface ExportProxyRequest {
  readonly authHeader: string | null;
  readonly reportId?: string;
}

export async function handleReportExportProxy(
  baseUrl: string,
  request: ExportProxyRequest,
): Promise<Response> {
  if (!request.authHeader) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (!request.reportId?.trim()) {
    return new Response(JSON.stringify({ error: 'Missing reportId' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const encodedId = encodeURIComponent(request.reportId);
  return forwardUpstreamResponse({
    baseUrl,
    path: `/api/reports/${encodedId}/export`,
    method: 'GET',
    authHeader: request.authHeader,
    accept: 'text/csv, application/json',
  });
}
