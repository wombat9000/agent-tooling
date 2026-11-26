import { useState } from 'react';

interface MemberRow {
  id: string;
  email: string;
}

interface RefreshableMemberListProps {
  initialMembers: MemberRow[];
  fetchMembers: () => Promise<MemberRow[]>;
}

export function RefreshableMemberList({ initialMembers, fetchMembers }: RefreshableMemberListProps) {
  const [members, setMembers] = useState<MemberRow[]>(initialMembers);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  async function handleRefresh() {
    setIsRefreshing(true);
    setRefreshError(null);
    try {
      const latest = await fetchMembers();
      setMembers(latest);
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : 'Refresh failed');
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <section>
      <div className="flex gap-2">
        <button type="button" disabled={isRefreshing} onClick={() => void handleRefresh()}>
          {isRefreshing ? 'Refreshing...' : 'Refresh'}
        </button>
        <button type="button" onClick={() => setIsHelpOpen((open) => !open)}>
          {isHelpOpen ? 'Hide help' : 'Show help'}
        </button>
      </div>
      {isHelpOpen ? <p>Members refresh in place while existing rows remain visible.</p> : null}
      {refreshError ? <p role="alert">{refreshError}</p> : null}
      <ul>
        {members.map((member) => (
          <li key={member.id}>{member.email}</li>
        ))}
      </ul>
    </section>
  );
}
