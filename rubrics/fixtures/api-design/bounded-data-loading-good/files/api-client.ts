import type {
  MemberListItem,
  MemberQueryParams,
  MemberSummaryResponse,
  PagedResponse,
  UserNotificationPreference,
} from './types';

export async function fetchMemberSummary(
  baseUrl: string,
  authToken: string,
): Promise<MemberSummaryResponse> {
  const response = await fetch(`${baseUrl}/api/members/summary`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch member summary: ${response.status}`);
  }
  return (await response.json()) as MemberSummaryResponse;
}

export async function searchMembersPage(
  baseUrl: string,
  authToken: string,
  params: MemberQueryParams,
): Promise<PagedResponse<MemberListItem>> {
  const search = new URLSearchParams();
  if (params.query?.trim()) search.set('q', params.query.trim());
  if (params.status) search.set('status', params.status);
  if (params.cursor) search.set('cursor', params.cursor);
  search.set('limit', String(Math.min(100, Math.max(1, params.limit ?? 25))));

  const response = await fetch(`${baseUrl}/api/members?${search.toString()}`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to search members: ${response.status}`);
  }
  return (await response.json()) as PagedResponse<MemberListItem>;
}

export async function fetchOwnNotificationPreferences(
  baseUrl: string,
  authToken: string,
): Promise<readonly UserNotificationPreference[]> {
  const response = await fetch(`${baseUrl}/api/me/notification-preferences`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch preferences: ${response.status}`);
  }
  return (await response.json()) as readonly UserNotificationPreference[];
}
