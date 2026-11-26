import { useEffect, useState } from 'react';

interface ViewportBannerProps {
  onDismiss: () => Promise<void>;
}

export function ViewportBanner({ onDismiss }: ViewportBannerProps) {
  const [isNarrow, setIsNarrow] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 768px)');
    const syncMatches = () => setIsNarrow(mediaQuery.matches);
    syncMatches();
    mediaQuery.addEventListener('change', syncMatches);
    return () => {
      mediaQuery.removeEventListener('change', syncMatches);
    };
  }, []);

  async function handleDismissClick() {
    await onDismiss();
  }

  if (!isNarrow) return null;

  return (
    <aside role="status">
      <p>Compact layout active.</p>
      <button type="button" onClick={handleDismissClick}>
        Dismiss
      </button>
    </aside>
  );
}
