import { useState } from 'react';
import { WorkspaceShell } from './WorkspaceShell';
import { ProfileDraftForm, type ProfileSnapshot } from './ProfileDraftForm';

interface DirectoryPageProps {
  searchParams: URLSearchParams;
  onSearchParamsChange: (next: URLSearchParams) => void;
  initialProfile: ProfileSnapshot;
  onSaveProfile: (draft: ProfileSnapshot) => Promise<void>;
}

function FilterTipsPopover() {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setIsOpen((open) => !open)}>
        Filter tips
      </button>
      {isOpen ? <p>Use exact role titles to narrow results.</p> : null}
    </div>
  );
}

export function DirectoryPage({
  searchParams,
  onSearchParamsChange,
  initialProfile,
  onSaveProfile,
}: DirectoryPageProps) {
  const activeQuery = searchParams.get('q') ?? '';
  const activeRegion = searchParams.get('region') ?? 'all';

  function updateParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    onSearchParamsChange(next);
  }

  return (
    <WorkspaceShell title="Directory">
      <div className="flex items-center gap-3">
        <input
          aria-label="Search query"
          value={activeQuery}
          onChange={(e) => updateParam('q', e.target.value)}
        />
        <select
          aria-label="Region"
          value={activeRegion}
          onChange={(e) => updateParam('region', e.target.value)}
        >
          <option value="all">All regions</option>
          <option value="eu">Europe</option>
          <option value="us">North America</option>
        </select>
        <FilterTipsPopover />
      </div>
      <ProfileDraftForm initialProfile={initialProfile} onSave={onSaveProfile} />
    </WorkspaceShell>
  );
}
