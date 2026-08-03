type BrandMarkProps = {
  compact?: boolean;
};

export function BrandMark({ compact = false }: BrandMarkProps) {
  return (
    <a className={`brand-mark${compact ? " brand-mark-compact" : ""}`} href="#main-content" aria-label="MAM Team Management home">
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
    </a>
  );
}
