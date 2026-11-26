export type DeliveryProvider = 'webhook' | 'email_relay';

export interface OutboundAlert {
  readonly provider: DeliveryProvider;
  readonly recipient: string;
  readonly subject: string;
  readonly body: string;
}

export interface TransportEndpoints {
  readonly webhookUrl: string;
  readonly emailRelayUrl: string;
  readonly apiToken: string;
}

async function postJson(url: string, apiToken: string, payload: Record<string, string>): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Delivery endpoint returned HTTP ${response.status}`);
  }
}

export async function sendAlert(endpoints: TransportEndpoints, alert: OutboundAlert): Promise<void> {
  switch (alert.provider) {
    case 'webhook':
      await postJson(endpoints.webhookUrl, endpoints.apiToken, {
        channel: alert.recipient,
        title: alert.subject,
        message: alert.body,
      });
      return;
    case 'email_relay':
      await postJson(endpoints.emailRelayUrl, endpoints.apiToken, {
        to: alert.recipient,
        subject: alert.subject,
        text: alert.body,
      });
      return;
  }
}
