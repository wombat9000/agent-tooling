export type NotificationChannel = 'email' | 'in_app' | 'sms';

export interface NotificationEnvelope {
  readonly id: string;
  readonly recipientId: string;
  readonly channel: NotificationChannel;
  readonly sentAtIso: string;
}
