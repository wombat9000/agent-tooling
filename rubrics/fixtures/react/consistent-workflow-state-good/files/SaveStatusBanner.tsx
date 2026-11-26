interface SaveStatusBannerProps {
  loaded: boolean;
  saving: boolean;
  dirty: boolean;
  error: string;
}

export function SaveStatusBanner({ loaded, saving, dirty, error }: SaveStatusBannerProps) {
  const label = !loaded
    ? (error ? 'Unavailable' : 'Loading...')
    : saving
      ? 'Saving...'
      : dirty
        ? 'Unsaved changes'
        : 'Saved';
  return <p role="status">{label}</p>;
}
