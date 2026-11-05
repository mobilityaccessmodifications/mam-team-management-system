import type { EmployeeLocation, EmployeeTimesheetEntries } from "./employee-directory-types";

/** Default to the timesheet system for the employee's physical work location.
 * A staff member's actual agreement can override this suggestion in the form.
 */
export function defaultTimesheetEntriesForLocation(location: EmployeeLocation): EmployeeTimesheetEntries {
  switch (location) {
    case "hq": return "deputy";
    case "onsite_trade": return "aroflo";
    case "remote_worker":
    case "overseas": return "hubstaff";
    case "hybrid": return "deputy_hubstaff";
    default: return "";
  }
}
