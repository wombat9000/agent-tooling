import type { AnnouncementResponse, AnnouncementStatus } from './announcement-dto';

export interface AnnouncementRow {
  readonly id: string;
  readonly title: string;
  readonly body_markdown: string;
  readonly status: AnnouncementStatus;
  readonly published_at_iso: string | null;
}

export function toAnnouncementResponse(row: AnnouncementRow): AnnouncementResponse {
  return {
    id: row.id,
    title: row.title,
    bodyMarkdown: row.body_markdown,
    status: row.status,
    publishedAtIso: row.published_at_iso,
  };
}
