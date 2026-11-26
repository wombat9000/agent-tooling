export interface HttpRequest {
  readonly method: string;
  readonly contentType?: string;
  readonly body: unknown;
}

export interface WebhookConfig {
  readonly endpointUrl: string;
  readonly maxRetryAttempts: number;
  readonly timeoutMs: number;
}

export const WEBHOOK_FIELD_CONSTRAINTS = {
  endpointUrl: (value: string) => value.startsWith('https://') && value.length <= 2048,
  maxRetryAttempts: (value: number) => Number.isInteger(value) && value >= 0 && value <= 10,
  timeoutMs: (value: number) => Number.isInteger(value) && value >= 500 && value <= 30_000,
} as const;

export function isRetryableWebhookStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode <= 599);
}

export function parseWebhookConfig(req: HttpRequest): WebhookConfig | null {
  if (req.method !== 'POST' || !req.contentType?.startsWith('application/json')) {
    return null;
  }
  if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return null;
  }
  const payload = req.body as Record<string, unknown>;
  const endpointUrl = typeof payload.endpointUrl === 'string' ? payload.endpointUrl.trim() : '';
  const maxRetryAttempts = typeof payload.maxRetryAttempts === 'number' ? payload.maxRetryAttempts : 3;
  const timeoutMs = typeof payload.timeoutMs === 'number' ? payload.timeoutMs : 5_000;
  if (
    !WEBHOOK_FIELD_CONSTRAINTS.endpointUrl(endpointUrl) ||
    !WEBHOOK_FIELD_CONSTRAINTS.maxRetryAttempts(maxRetryAttempts) ||
    !WEBHOOK_FIELD_CONSTRAINTS.timeoutMs(timeoutMs)
  ) {
    return null;
  }
  return { endpointUrl, maxRetryAttempts, timeoutMs };
}
