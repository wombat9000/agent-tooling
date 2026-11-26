export type AnnouncementStatus = 'draft' | 'published' | 'archived';

// Returning all three renderings avoids markdown parsing on lightweight clients.
export interface AnnouncementResponse {
  readonly id: string;
  readonly title: string;
  readonly renderedMarkup: string;
  readonly renderedPlainText: string;
  readonly renderedHtml: string;
  readonly status: AnnouncementStatus;
  readonly statusDisplayLabel: string;
  readonly statusBadgeText: string;
  readonly publishedAtIso: string | null;
  readonly publishedAtFormatted: string;
}
