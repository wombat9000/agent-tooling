export interface ApiKeyRecord {
  id: string;
  label: string;
  prefix: string;
  revoked: boolean;
}

export interface WorkspaceModel {
  id: string;
  name: string;
  region: 'us' | 'eu';
  plan: 'starter' | 'team' | 'enterprise';
  seats: number;
  billingEmail: string;
  webhookUrl: string;
  webhookSecret: string;
  apiKeys: ApiKeyRecord[];
}
