export interface TranslationRequest {
  readonly text: string;
  readonly targetLocale: string;
}

export interface TranslationTelemetry {
  readonly latencyMs: number;
  readonly billedChars: number;
  readonly estimatedCostUsd: number;
}

export interface TranslationResponse {
  readonly translatedText: string;
  readonly telemetry: TranslationTelemetry;
}

export class TranslationProviderError extends Error {
  readonly statusCode: number | null;
  readonly retryable: boolean;

  constructor(message: string, statusCode: number | null, retryable: boolean) {
    super(message);
    this.name = 'TranslationProviderError';
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

const USD_PER_CHAR = 0.00002;
const MAX_RESPONSE_BYTES = 262_144;

function parseProviderPayload(rawBody: string): { readonly translatedText: string; readonly billedChars: number } {
  if (rawBody.length > MAX_RESPONSE_BYTES) {
    throw new TranslationProviderError('Provider response exceeded byte limit', 502, false);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new TranslationProviderError('Provider returned malformed JSON', 502, false);
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as Record<string, unknown>).translatedText !== 'string') {
    throw new TranslationProviderError('Provider response missing translatedText', 502, false);
  }
  const record = parsed as Record<string, unknown>;
  const billedChars = typeof record.billedChars === 'number' && record.billedChars >= 0 ? record.billedChars : 0;
  return { translatedText: record.translatedText as string, billedChars };
}

export class TranslationProviderAdapter {
  private readonly endpointUrl: string;
  private readonly authToken: string;
  private readonly timeoutMs: number;

  constructor(config: { readonly endpointUrl: string; readonly authToken: string; readonly timeoutMs?: number }) {
    this.endpointUrl = config.endpointUrl;
    this.authToken = config.authToken;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(this.endpointUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: request.text, target_locale: request.targetLocale }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new TranslationProviderError('Translation provider request failed', null, true);
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new TranslationProviderError(`Translation provider HTTP ${response.status}`, response.status, retryable);
    }

    const payload = parseProviderPayload(await response.text());
    return {
      translatedText: payload.translatedText,
      telemetry: {
        latencyMs: Date.now() - startedAt,
        billedChars: payload.billedChars,
        estimatedCostUsd: Number((payload.billedChars * USD_PER_CHAR).toFixed(6)),
      },
    };
  }
}
