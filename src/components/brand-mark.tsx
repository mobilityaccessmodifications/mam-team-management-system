type BrandMarkProps = {
  compact?: boolean;
};

export function BrandMark({ compact = false }: BrandMarkProps) {
  return (
    <div className={`brand-mark${compact ? " brand-mark-compact" : ""}`} aria-label="MAM Team Management">
      <span className="brand-symbol" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {!compact ? (
        <span className="brand-words">
          <strong>MAM</strong>
          <small>Team Management</small>
        </span>
      ) : null}
    </div>
  );
}
