export type AnnouncementStatus = 'draft' | 'published' | 'archived';

export interface AnnouncementResponse {
  readonly id: string;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly status: AnnouncementStatus;
  readonly publishedAtIso: string | null;
}

export interface AnnouncementSummaryCounts {
  readonly total: number;
  readonly draft: number;
  readonly published: number;
}
