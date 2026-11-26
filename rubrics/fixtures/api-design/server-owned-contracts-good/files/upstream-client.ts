export interface UpstreamConfig {
  readonly baseUrl: string;
}

export async function forwardJsonRequest(
  config: UpstreamConfig,
  path: string,
  init: { readonly method: string; readonly authHeader: string; readonly body?: string },
): Promise<{ readonly status: number; readonly body: string }> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: init.method,
    headers: {
      Authorization: init.authHeader,
      'Content-Type': 'application/json',
    },
    body: init.body,
  });
  return { status: response.status, body: await response.text() };
}
