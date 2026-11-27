import {
  fetchMemberSummary,
  fetchOwnNotificationPreferences,
  searchMembersPage,
} from './api-client';
import type {
  MemberListItem,
  MemberQueryParams,
  MemberSummaryResponse,
  PagedResponse,
  UserNotificationPreference,
} from './types';

export interface DashboardPageData {
  readonly summary: MemberSummaryResponse;
  readonly membersPage: PagedResponse<MemberListItem>;
  readonly preferences: readonly UserNotificationPreference[];
}

export async function loadDashboardPage(
  baseUrl: string,
  authToken: string,
  params: MemberQueryParams,
): Promise<DashboardPageData> {
  const [summary, membersPage, preferences] = await Promise.all([
    fetchMemberSummary(baseUrl, authToken),
    searchMembersPage(baseUrl, authToken, { ...params, status: params.status ?? 'active' }),
    fetchOwnNotificationPreferences(baseUrl, authToken),
  ]);
  return { summary, membersPage, preferences };
}

export async function exportFilteredMembers(
  baseUrl: string,
  authToken: string,
  params: Omit<MemberQueryParams, 'cursor'>,
): Promise<readonly MemberListItem[]> {
  const exported: MemberListItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  while (true) {
    const page = await searchMembersPage(baseUrl, authToken, { ...params, cursor, limit: 100 });
    exported.push(...page.items);
    if (!page.hasMore || !page.nextCursor) {
      break;
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new Error(`Repeating pagination cursor detected during export: ${page.nextCursor}`);
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  return exported;
}
