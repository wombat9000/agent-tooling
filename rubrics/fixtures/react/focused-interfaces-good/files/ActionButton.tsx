interface ActionButtonProps {
  label: string;
  disabled?: boolean;
  compact?: boolean;
  showIcon?: boolean;
  onClick: () => void;
}

export function ActionButton({
  label,
  disabled = false,
  compact = false,
  showIcon = true,
  onClick,
}: ActionButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={compact ? 'px-2 py-1 text-xs rounded border' : 'px-4 py-2 text-sm rounded border'}
    >
      {showIcon ? <span aria-hidden="true">+ </span> : null}
      {label}
    </button>
  );
}
