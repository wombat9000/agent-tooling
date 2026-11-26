import type { CampaignDto, UpdateCampaignRequest } from './campaign-dto';

export interface CampaignService {
  getById(id: string): Promise<CampaignDto | null>;
  update(id: string, patch: UpdateCampaignRequest, expectedVersion: number): Promise<CampaignDto>;
  send(id: string, idempotencyKey: string): Promise<CampaignDto>;
}
