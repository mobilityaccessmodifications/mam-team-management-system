type BrandMarkProps = {
  compact?: boolean;
};

export function BrandMark({ compact = false }: BrandMarkProps) {
  return (
    <div className={`brand-mark${compact ? " brand-mark-compact" : ""}`} aria-label="People Hub">
      <span className="brand-symbol" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {!compact ? (
        <span className="brand-words">
          <strong>People Hub</strong>
        </span>
      ) : null}
    </div>
  );
}
