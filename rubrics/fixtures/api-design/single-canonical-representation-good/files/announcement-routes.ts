import { toAnnouncementResponse, type AnnouncementRow } from './announcement-mapper';

export function handleGetAnnouncement(row: AnnouncementRow | null) {
  if (!row) {
    return { status: 404, body: { error: 'Announcement not found' } };
  }
  return { status: 200, body: toAnnouncementResponse(row) };
}
