import type { MessageTemplateDto } from './template-types';

export interface RawTemplateRow {
  readonly id: string;
  readonly name: string;
  readonly subject: string;
  readonly bodyMarkdown: string;
}

export function enrichTemplateForList(
  row: RawTemplateRow,
  options: { readonly forPicker: boolean; readonly searchTerm?: string },
): MessageTemplateDto {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    bodyMarkdown: row.bodyMarkdown,
    targetSubstages: ['onboarding_step_2', 'renewal_check'],
    suggestedCohortIds: options.forPicker ? ['cohort-west', 'cohort-enterprise'] : [],
    upcomingPaymentPlanSummary: undefined,
    attachments: [],
    isDemo: row.id.startsWith('demo_'),
    ...(options.searchTerm ? { queryMatchScore: 0.95 } : {}),
    ...(options.forPicker ? { pickerBadgeColor: 'blue' } : {}),
  };
}
