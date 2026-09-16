import type {
  EmployeeWorkingDayTime,
  EmployeeWorkingWeekday,
} from "@/lib/employee-directory-types";

export type WorkScheduleRequestStatus = "submitted" | "approved" | "declined" | "cancelled";

export type WorkScheduleHistoryItem = {
  id: string;
  originalWorkingWeekdays: EmployeeWorkingWeekday[] | null;
  originalWorkingDayTimes: EmployeeWorkingDayTime[];
  requestedWorkingWeekdays: EmployeeWorkingWeekday[];
  requestedWorkingDayTimes: EmployeeWorkingDayTime[];
  requestReason: string;
  submittedByName: string;
  status: WorkScheduleRequestStatus;
  submittedAt: string;
  decidedAt: string | null;
  reviewerName: string | null;
  decisionReason: string | null;
};

export type WorkScheduleReviewItem = WorkScheduleHistoryItem & {
  personId: string;
  employeeName: string;
};

export type WorkScheduleWorkspace = {
  activePersonId: string | null;
  activePersonName: string | null;
  workingWeekdays: EmployeeWorkingWeekday[] | null;
  workingDayTimes: EmployeeWorkingDayTime[];
  initialSetupAvailable: boolean;
  canRequestChange: boolean;
  isProfilePreview: boolean;
  history: WorkScheduleHistoryItem[];
  reviews: WorkScheduleReviewItem[];
};

export type WorkScheduleLoadResult =
  | { ok: true; workspace: WorkScheduleWorkspace }
  | {
      ok: false;
      kind: "access" | "target" | "data" | "transient";
      message: string;
    };

export type WorkScheduleMutationResult =
  | { ok: true; outcome?: "applied" | "submitted" }
  | { ok: false; message: string };
