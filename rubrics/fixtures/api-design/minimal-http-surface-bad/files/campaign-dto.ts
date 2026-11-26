// Unified super-DTO allows all campaign screens and importers to share one endpoint.
export interface CampaignMegaPayload {
  readonly id: string;
  readonly name?: string;
  readonly subject?: string;
  readonly bodyMarkdown?: string;
  readonly surveyQuestions?: readonly string[];
  readonly csvImportBatchId?: string;
  readonly billingAccountSnapshot?: Record<string, unknown>;
  readonly analyticsRollup?: Record<string, number>;
  readonly archiveOnly?: boolean;
  readonly resetDraftOnly?: boolean;
  readonly previewHash?: string;
  readonly previewToken?: string;
  readonly previewExpiresAtIso?: string;
  readonly rpcAction?: 'update' | 'preview' | 'send' | 'import_csv' | 'clone';
}
