import { ChevronDown, Filter } from "lucide-react";
import styles from "@/components/team-calendar.module.css";

export function CalendarFilters({ kinds, teams, leaveTypes, hiddenKinds, hiddenTeams, hiddenLeaveTypes, onKind, onTeam, onLeaveType, onReset }: {
  kinds: ReadonlyArray<{ id: string; name: string }>;
  teams: string[];
  leaveTypes: string[];
  hiddenKinds: string[];
  hiddenTeams: string[];
  hiddenLeaveTypes: string[];
  onKind: (id: string) => void;
  onTeam: (team: string) => void;
  onLeaveType: (leaveType: string) => void;
  onReset: () => void;
}) {
  const hiddenCount = kinds.filter((kind) => hiddenKinds.includes(kind.id)).length
    + teams.filter((team) => hiddenTeams.includes(team)).length
    + leaveTypes.filter((type) => hiddenLeaveTypes.includes(type)).length;
  return <details className={styles.filters} onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}>
    <summary><Filter size={16} aria-hidden="true" />Filters{hiddenCount ? <span>{hiddenCount} hidden</span> : null}<ChevronDown size={16} aria-hidden="true" /></summary>
    <div className={styles.filterPanel}>
      <div className={styles.filterHeading}><strong>Show on calendar</strong><button type="button" onClick={onReset} disabled={!hiddenCount}>Show all</button></div>
      <div className={styles.filterGroups}>
        <fieldset><legend>Events</legend><div className={styles.filterOptions}>{kinds.map((kind) => <label key={kind.id}><input type="checkbox" checked={!hiddenKinds.includes(kind.id)} onChange={() => onKind(kind.id)} /><span>{kind.name}</span></label>)}</div></fieldset>
        {leaveTypes.length ? <fieldset><legend>Leave by type</legend><div className={styles.filterOptions}>{leaveTypes.map((leaveType) => <label key={leaveType}><input type="checkbox" checked={!hiddenLeaveTypes.includes(leaveType)} onChange={() => onLeaveType(leaveType)} /><span>{leaveType}</span></label>)}</div></fieldset> : null}
        {teams.length ? <fieldset><legend>Leave by team</legend><div className={styles.filterOptions}>{teams.map((team) => <label key={team}><input type="checkbox" checked={!hiddenTeams.includes(team)} onChange={() => onTeam(team)} /><span>{team}</span></label>)}</div></fieldset> : null}
      </div>
    </div>
  </details>;
}
