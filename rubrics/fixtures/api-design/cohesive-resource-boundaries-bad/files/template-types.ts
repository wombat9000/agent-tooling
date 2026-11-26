// Includes picker suggestions and future attachment metadata to reduce client round-trips.
export interface PlaceholderAttachmentMeta {
  readonly filename: string;
  readonly sizeBytes: number;
  readonly storageKey: string | null;
}

export interface MessageTemplateDto {
  readonly id: string;
  readonly name: string;
  readonly subject: string;
  readonly bodyMarkdown: string;
  readonly targetSubstages: readonly string[];
  readonly suggestedCohortIds: readonly string[];
  readonly upcomingPaymentPlanSummary?: string;
  readonly attachments: readonly PlaceholderAttachmentMeta[];
  readonly isDemo?: boolean;
  readonly queryMatchScore?: number;
  readonly pickerBadgeColor?: string;
}
