/** Presentation filters only. All inputs must already be server-authorised. */
export function calendarEventIsVisible(
  kind: string,
  team: string | undefined,
  hiddenKinds: readonly string[],
  hiddenTeams: readonly string[],
) {
  return !hiddenKinds.includes(kind) && (!team || !hiddenTeams.includes(team));
}

export function calendarTeamOptions(requests: ReadonlyArray<{ team: string }>) {
  return Array.from(new Set(requests.map((request) => request.team).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, "en-AU"));
}
