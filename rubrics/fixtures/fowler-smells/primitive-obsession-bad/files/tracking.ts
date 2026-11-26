export interface TrackingReference {
  readonly shipmentId: string;
  readonly createdAtIso: string;
}

export function formatTrackingReference(ref: TrackingReference): string {
  return `${ref.shipmentId} (${ref.createdAtIso})`;
}
