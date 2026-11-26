interface ProfileDetailsSectionProps {
  displayName: string;
  contactEmail: string;
  disabled: boolean;
  onDisplayNameChange: (value: string) => void;
}

export function ProfileDetailsSection({
  displayName,
  contactEmail,
  disabled,
  onDisplayNameChange,
}: ProfileDetailsSectionProps) {
  return (
    <section aria-labelledby="profile-details-heading" className="rounded-lg border p-4 space-y-4">
      <h2 id="profile-details-heading" className="text-lg font-medium">Profile details</h2>
      <div className="space-y-1">
        <label htmlFor="display-name" className="block text-sm font-medium">Display name</label>
        <input
          id="display-name"
          type="text"
          value={displayName}
          disabled={disabled}
          onChange={(event) => onDisplayNameChange(event.target.value)}
          className="w-full rounded border px-3 py-2"
        />
      </div>
      <div className="space-y-1">
        <span className="block text-sm font-medium">Contact email</span>
        <p className="text-sm text-slate-600">{contactEmail}</p>
      </div>
    </section>
  );
}
