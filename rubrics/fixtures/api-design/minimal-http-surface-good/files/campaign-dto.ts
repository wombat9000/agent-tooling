export type CampaignStatus = 'draft' | 'sent';

export interface CampaignDto {
  readonly id: string;
  readonly name: string;
  readonly subject: string;
  readonly bodyMarkdown: string;
  readonly status: CampaignStatus;
  readonly version: number;
}

export interface UpdateCampaignRequest {
  readonly name?: string;
  readonly subject?: string;
  readonly bodyMarkdown?: string;
}
