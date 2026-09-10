/**
 * NES accrual arithmetic, verified against Fair Work on 2026-09-10.
 * See docs/leave-accrual.md for sources and the production activation gate.
 * This module has no balance writes and does not infer ordinary hours from
 * elapsed calendar days, attendance, job titles or an ABN alone.
 */
export type AccrualEmployment = "full_time" | "part_time" | "casual" | "contractor";

export type LeaveAccrualPolicy = {
  employment: AccrualEmployment;
  nationalSystemCoverageConfirmed: boolean;
  /** Confirmed NES shiftworker classification, not merely working shifts. */
  nesShiftworker: boolean;
  /** Include any more generous award/agreement/contract entitlement. */
  annualWeeksPerYear: number;
  /** NES personal/carer's leave minimum: two ordinary working weeks. */
  personalWeeksPerYear: number;
};

export type EligibleOrdinaryHours = {
  /** Separately classified because some absences have entitlement-specific rules. */
  annual: number;
  personal: number;
};

function nonNegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite, non-negative number.`);
  }
}

/**
 * Calculate an increment from confirmed eligible ordinary hours. Include paid
 * leave and qualifying service, exclude overtime and non-accruing absences.
 * Personal leave is the single shared sick/carer's entitlement.
 * Keep full precision in calculations; round only at the presentation/storage
 * boundary, with a durable remainder if posting small daily increments.
 */
export function calculateLeaveAccrual(
  policy: LeaveAccrualPolicy,
  hours: EligibleOrdinaryHours,
): { annualHours: number; personalHours: number } {
  if (!policy.nationalSystemCoverageConfirmed) {
    throw new Error("Confirm applicable employment coverage before calculating NES accrual.");
  }
  if (!["full_time", "part_time", "casual", "contractor"].includes(policy.employment)) {
    throw new Error("Confirmed employment classification is required.");
  }
  nonNegativeFinite(hours.annual, "Annual eligible ordinary hours");
  nonNegativeFinite(hours.personal, "Personal eligible ordinary hours");
  nonNegativeFinite(policy.annualWeeksPerYear, "Annual entitlement");
  nonNegativeFinite(policy.personalWeeksPerYear, "Personal entitlement");
  if (policy.employment === "casual" || policy.employment === "contractor") {
    return { annualHours: 0, personalHours: 0 };
  }
  const minimumAnnualWeeks = policy.nesShiftworker ? 5 : 4;
  if (policy.annualWeeksPerYear < minimumAnnualWeeks || policy.personalWeeksPerYear < 2) {
    throw new Error("Entitlement is below the applicable NES minimum.");
  }
  const annualHours = hours.annual * (policy.annualWeeksPerYear / 52);
  const personalHours = hours.personal * (policy.personalWeeksPerYear / 52);
  if (!Number.isFinite(annualHours) || !Number.isFinite(personalHours)) {
    throw new Error("Accrual exceeds the supported numeric range.");
  }
  return { annualHours, personalHours };
}
