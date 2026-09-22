/** The active candidate list must never silently hide a retained membership. */
export function unavailableSubscriptionMemberIds(
  people: readonly { personId: string }[],
  selectedIds: readonly string[],
) {
  const activeIds = new Set(people.map((person) => person.personId));
  return selectedIds.filter((id) => !activeIds.has(id));
}

/** Includes uncontrolled inputs, the employee picker's hidden ID and member state. */
export function subscriptionEditorSnapshot(form: FormData, memberIds: readonly string[]) {
  return JSON.stringify({
    fields: Array.from(form.entries()).sort(([left], [right]) => left.localeCompare(right)),
    members: [...memberIds].sort(),
  });
}
