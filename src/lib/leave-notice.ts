/** Compatibility helper for integrations: short-notice leave is now permitted.
 * All leave requests still undergo the normal date, eligibility, balance
 * and manager approval checks.
 */
export function requiresLeaveNotice(_input: {
  employmentType: string | null;
  leaveType: string;
  startDate: string;
  onBehalfOf: boolean;
}, _today?: string) {
  return false;
}
