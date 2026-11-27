const PASSTHROUGH_RESPONSE_HEADERS = [
  'content-type',
  'content-disposition',
  'cache-control',
  'etag',
] as const;

export interface ForwardRequestOptions {
  readonly baseUrl: string;
  readonly path: string;
  readonly method: string;
  readonly authHeader: string;
  readonly accept?: string;
  readonly body?: BodyInit | null;
}

export async function forwardUpstreamResponse(options: ForwardRequestOptions): Promise<Response> {
  const upstreamHeaders = new Headers({
    Authorization: options.authHeader,
  });
  if (options.accept) {
    upstreamHeaders.set('Accept', options.accept);
  }

  const upstream = await fetch(`${options.baseUrl}${options.path}`, {
    method: options.method,
    headers: upstreamHeaders,
    body: options.body ?? undefined,
  });

  const responseHeaders = new Headers();
  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) {
      responseHeaders.set(name, value);
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
