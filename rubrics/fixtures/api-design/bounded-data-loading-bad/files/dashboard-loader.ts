import { fetchAllMembers, fetchMemberDetail, fetchOrdersPageOne } from './api-client';
import type { DashboardSnapshot, MemberDetail, MemberSummary } from './types';

export async function loadDashboardSnapshot(
  baseUrl: string,
  authToken: string,
  searchQuery: string,
): Promise<DashboardSnapshot> {
  const allMembers = await fetchAllMembers(baseUrl, authToken);
  const countsByTier: Record<MemberSummary['tier'], number> = {
    starter: 0,
    growth: 0,
    enterprise: 0,
  };
  for (const member of allMembers) {
    countsByTier[member.tier] += 1;
  }

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filtered = allMembers.filter((member) => (
    member.status === 'active'
    && (normalizedQuery === ''
      || member.fullName.toLowerCase().includes(normalizedQuery)
      || member.email.toLowerCase().includes(normalizedQuery))
  ));

  const matchingMembers: MemberDetail[] = [];
  for (const member of filtered) {
    matchingMembers.push(await fetchMemberDetail(baseUrl, authToken, member.id));
  }

  const recentOrders = await fetchOrdersPageOne(baseUrl, authToken);
  return { matchingMembers, countsByTier, recentOrders };
}
