/** Directory classification only; never an authorisation or reporting rule. */
export const EMPLOYEE_TEAMS = ["Operation & Accounts", "Management", "Major", "Minor", "Warehouse", "Equipsy"] as const;

export function requireEmployeeTeam(value: unknown): string {
  if (typeof value !== "string" || !(EMPLOYEE_TEAMS as readonly string[]).includes(value)) {
    throw new Error("Choose a team from the list.");
  }
  return value;
}
