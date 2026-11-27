import type { MemberDetail, MemberSummary, OrderRecord, PagedResponse } from './types';

export async function fetchAllMembers(baseUrl: string, authToken: string): Promise<MemberSummary[]> {
  const allMembers: MemberSummary[] = [];
  let cursor: string | null = null;
  let firstRequest = true;

  // Fetch every page into memory so the dashboard can filter and aggregate locally.
  while (firstRequest || cursor !== null) {
    firstRequest = false;
    const query = cursor ? `?limit=200&cursor=${encodeURIComponent(cursor)}` : '?limit=200';
    const response = await fetch(`${baseUrl}/api/members${query}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch members: ${response.status}`);
    }
    const page = (await response.json()) as PagedResponse<MemberSummary>;
    allMembers.push(...page.items);
    cursor = page.nextCursor;
  }

  return allMembers;
}

export async function fetchMemberDetail(
  baseUrl: string,
  authToken: string,
  memberId: string,
): Promise<MemberDetail> {
  const response = await fetch(`${baseUrl}/api/members/${encodeURIComponent(memberId)}`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to load member ${memberId}: ${response.status}`);
  }
  return (await response.json()) as MemberDetail;
}

export async function fetchOrdersPageOne(
  baseUrl: string,
  authToken: string,
): Promise<readonly OrderRecord[]> {
  const response = await fetch(`${baseUrl}/api/orders?page=1&limit=100`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch orders: ${response.status}`);
  }
  const page = (await response.json()) as PagedResponse<OrderRecord>;
  return page.items;
}
