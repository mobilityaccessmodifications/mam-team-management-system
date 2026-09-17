import { Check, Focus, LocateFixed, Maximize2, Minimize2, Minus, Plus, SlidersHorizontal, Undo2, WandSparkles } from "lucide-react";
import { type Dispatch, type SetStateAction, useRef, useState } from "react";
import styles from "@/components/organisation-tree.module.css";

export type OrganisationFilter = "all" | "mam" | "equipsy" | "major" | "minor" | "warehouse";

export function OrganisationFilterMenu({ companyFilter, onSelect }: {
  companyFilter: OrganisationFilter;
  onSelect: (filter: OrganisationFilter) => void;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <div
      className={styles.filterMenu}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !filterOpen) return;
        event.preventDefault();
        event.stopPropagation();
        setFilterOpen(false);
        filterButtonRef.current?.focus();
      }}
    >
      <button
        aria-label="Filter organisation"
        aria-expanded={filterOpen}
        aria-haspopup="menu"
        className={styles.filterButton}
        onClick={() => setFilterOpen((current) => !current)}
        ref={filterButtonRef}
        title="Filter"
        type="button"
      >
        <SlidersHorizontal aria-hidden="true" size={17} />
        <span>Filter</span>
        {companyFilter !== "all" ? <span className={styles.filterBadge}>1</span> : null}
      </button>
      {filterOpen ? (
        <div aria-label="Organisation filters" className={styles.filterCard} role="menu">
          <span className={styles.filterHeading}>Show teams</span>
          {([
            ["all", "All"],
            ["mam", "MAM"],
            ["equipsy", "Equipsy"],
            ["major", "Major"],
            ["minor", "Minor"],
            ["warehouse", "Warehouse"],
          ] as const).map(([filter, label]) => (
            <button
              aria-checked={companyFilter === filter}
              className={styles.filterOption}
              data-active={companyFilter === filter}
              onClick={() => {
                onSelect(filter);
                setFilterOpen(false);
                filterButtonRef.current?.focus();
              }}
              key={filter}
              role="menuitemradio"
              type="button"
            >
              <span>{label}</span>
              {companyFilter === filter ? <Check aria-hidden="true" size={14} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function OrganisationChartControls({
  canArrange,
  canUseRelationshipEditor,
  hasManualOffsets,
  arrangeMode,
  hasRelationshipHistory,
  saving,
  zoom,
  minZoom,
  maxZoom,
  fullscreen,
  cleanUpChart,
  undoLastRelationship,
  setZoom,
  fitChart,
  resetView,
  toggleFullscreen,
}: {
  canArrange: boolean;
  canUseRelationshipEditor: boolean;
  hasManualOffsets: boolean;
  arrangeMode: boolean;
  hasRelationshipHistory: boolean;
  saving: boolean;
  zoom: number;
  minZoom: number;
  maxZoom: number;
  fullscreen: boolean;
  cleanUpChart: () => void;
  undoLastRelationship: () => Promise<void>;
  setZoom: Dispatch<SetStateAction<number>>;
  fitChart: () => void;
  resetView: () => void;
  toggleFullscreen: () => void;
}) {
  return (
    <div aria-label="Chart view controls" className={styles.chartControls}>
      {canArrange || canUseRelationshipEditor ? (
        <div aria-label="Chart editing" className={styles.chartControlGroup} role="group">
          {canArrange ? (
            <button
              aria-label="Clean up chart and restore the reporting layout"
              className={styles.cleanUpControl}
              disabled={!hasManualOffsets && !arrangeMode}
              onClick={cleanUpChart}
              title="Clean up chart"
              type="button"
            >
              <WandSparkles aria-hidden="true" size={16} />
              <span>Clean up</span>
            </button>
          ) : null}
          {canUseRelationshipEditor ? (
            <button
              aria-label="Undo last reporting-line change"
              disabled={!hasRelationshipHistory || saving}
              onClick={() => void undoLastRelationship()}
              title="Undo last reporting-line change"
              type="button"
            >
              <Undo2 aria-hidden="true" size={16} />
            </button>
          ) : null}
        </div>
      ) : null}
      <div aria-label="Zoom" className={`${styles.chartControlGroup} ${styles.zoomControlGroup}`} role="group">
        <button
          aria-label="Zoom out"
          disabled={zoom <= minZoom}
          onClick={() =>
            setZoom((current) =>
              Math.max(minZoom, Math.round((current - 0.1) * 100) / 100),
            )
          }
          type="button"
        >
          <Minus aria-hidden="true" size={16} />
        </button>
        <span aria-label={`${Math.round(zoom * 100)} percent zoom`}>
          {Math.round(zoom * 100)}%
        </span>
        <button
          aria-label="Zoom in"
          disabled={zoom >= maxZoom}
          onClick={() =>
            setZoom((current) =>
              Math.min(maxZoom, Math.round((current + 0.1) * 100) / 100),
            )
          }
          type="button"
        >
          <Plus aria-hidden="true" size={16} />
        </button>
      </div>
      <div aria-label="Chart framing" className={styles.chartControlGroup} role="group">
        <button
          aria-label="Fit chart to screen"
          className={styles.namedChartControl}
          onClick={fitChart}
          title="Fit chart to screen"
          type="button"
        >
          <LocateFixed aria-hidden="true" size={16} />
          <span>Fit</span>
        </button>
        <button aria-label="Reset chart view" onClick={resetView} title="Reset chart view" type="button">
          <Focus aria-hidden="true" size={16} />
        </button>
        <button
          aria-label={fullscreen ? "Exit full screen" : "Open full screen"}
          aria-pressed={fullscreen}
          onClick={toggleFullscreen}
          title={fullscreen ? "Exit full screen" : "Open full screen"}
          type="button"
        >
          {fullscreen ? (
            <Minimize2 aria-hidden="true" size={16} />
          ) : (
            <Maximize2 aria-hidden="true" size={16} />
          )}
        </button>
      </div>
    </div>
  );
}
