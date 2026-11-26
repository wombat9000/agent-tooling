import type { AnnouncementResponse, AnnouncementStatus } from './announcement-dto';

export interface AnnouncementRow {
  readonly id: string;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly status: AnnouncementStatus;
  readonly publishedAtIso: string | null;
}

const STATUS_LABELS: Record<AnnouncementStatus, string> = {
  draft: 'Draft (Not Visible)',
  published: 'Live to All Users',
  archived: 'Archived Notice',
};

export function toAnnouncementResponse(row: AnnouncementRow): AnnouncementResponse {
  const plainText = row.bodyMarkdown.replace(/[#*_`]/g, '');
  const html = `<p>${plainText}</p>`;
  return {
    id: row.id,
    title: row.title,
    renderedMarkup: row.bodyMarkdown,
    renderedPlainText: plainText,
    renderedHtml: html,
    status: row.status,
    statusDisplayLabel: STATUS_LABELS[row.status],
    statusBadgeText: row.status.toUpperCase(),
    publishedAtIso: row.publishedAtIso,
    publishedAtFormatted: row.publishedAtIso ? row.publishedAtIso.slice(0, 10) : 'Not published yet',
  };
}
