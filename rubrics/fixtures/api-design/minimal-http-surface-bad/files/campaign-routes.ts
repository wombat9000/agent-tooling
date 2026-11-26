import type { CampaignMegaPayload } from './campaign-dto';

export interface CampaignStore {
  computePreviewHash(id: string): Promise<string>;
  markSent(id: string): Promise<void>;
  archive(id: string): Promise<void>;
  resetDraft(id: string): Promise<void>;
  applyFields(id: string, payload: CampaignMegaPayload): Promise<void>;
}

export async function handleCampaignRpc(store: CampaignStore, payload: CampaignMegaPayload) {
  if (payload.rpcAction === 'send') {
    const expectedHash = await store.computePreviewHash(payload.id);
    if (!payload.previewHash || !payload.previewToken || payload.previewHash !== expectedHash) {
      return { status: 409, body: { error: 'Must call preview endpoint and pass matching previewHash + previewToken' } };
    }
    await store.markSent(payload.id);
    return { status: 200, body: { ok: true } };
  }
  if (payload.archiveOnly) {
    await store.archive(payload.id);
    return { status: 200, body: { archived: true } };
  }
  if (payload.resetDraftOnly) {
    await store.resetDraft(payload.id);
    return { status: 200, body: { reset: true } };
  }
  await store.applyFields(payload.id, payload);
  return { status: 200, body: { updated: true } };
}
