import { SlidersHorizontal } from "lucide-react";
import styles from "@/components/team-calendar.module.css";

export function CalendarFilters({ kinds, teams, hiddenKinds, hiddenTeams, onKind, onTeam, onReset }: {
  kinds: ReadonlyArray<{ id: string; name: string }>;
  teams: string[];
  hiddenKinds: string[];
  hiddenTeams: string[];
  onKind: (id: string) => void;
  onTeam: (team: string) => void;
  onReset: () => void;
}) {
  const hiddenCount = kinds.filter((kind) => hiddenKinds.includes(kind.id)).length
    + teams.filter((team) => hiddenTeams.includes(team)).length;
  return <details className={styles.filters}>
    <summary><SlidersHorizontal size={16} aria-hidden="true" />Filters{hiddenCount ? <span>{hiddenCount} hidden</span> : null}</summary>
    <div className={styles.filterPanel}>
      <div className={styles.filterHeading}><strong>Show on calendar</strong><button type="button" onClick={onReset} disabled={!hiddenCount}>Show all</button></div>
      <div className={styles.filterGroups}>
        <fieldset><legend>Events</legend><div className={styles.filterOptions}>{kinds.map((kind) => <label key={kind.id}><input type="checkbox" checked={!hiddenKinds.includes(kind.id)} onChange={() => onKind(kind.id)} /><span>{kind.name}</span></label>)}</div></fieldset>
        {teams.length ? <fieldset><legend>Leave by team</legend><div className={styles.filterOptions}>{teams.map((team) => <label key={team}><input type="checkbox" checked={!hiddenTeams.includes(team)} onChange={() => onTeam(team)} /><span>{team}</span></label>)}</div></fieldset> : null}
      </div>
    </div>
  </details>;
}
