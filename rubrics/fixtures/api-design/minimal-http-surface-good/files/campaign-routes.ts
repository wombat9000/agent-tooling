import type { UpdateCampaignRequest } from './campaign-dto';
import type { CampaignService } from './campaign-service';

export async function handlePatchCampaign(
  service: CampaignService,
  id: string,
  ifMatchVersion: number,
  patch: UpdateCampaignRequest,
) {
  const updated = await service.update(id, patch, ifMatchVersion);
  return { status: 200, headers: { ETag: `"${updated.version}"` }, body: updated };
}

export async function handleSendCampaign(
  service: CampaignService,
  id: string,
  idempotencyKey: string,
) {
  const sent = await service.send(id, idempotencyKey);
  return { status: 200, body: sent };
}
