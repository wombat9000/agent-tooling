export function formatPreviewToken(campaignId: string, hash: string): string {
  return `${campaignId}:${hash}`;
}
