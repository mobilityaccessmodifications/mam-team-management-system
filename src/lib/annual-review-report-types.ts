export type AnnualReviewStatus =
  | "Not Eligible"
  | "Not Triggered"
  | "Awaiting Both"
  | "Awaiting Employee"
  | "Awaiting Manager"
  | "Awaiting Finalisation"
  | "Finalised";

export type AnnualReviewReportRow = {
  employeeId: string;
  employeeName: string;
  company: string;
  department: string;
  jobTitle: string;
  employeeActive: boolean;
  employmentStartDate: string | null;
  eligible: boolean | null;
  reviewYear: string;
  reviewId: string | null;
  reviewNo: number | null;
  managerName: string | null;
  reviewTriggered: boolean;
  triggeredBy: string | null;
  triggeredDate: string | null;
  triggeredAt: string | null;
  employeeCompleted: boolean;
  employeeCompletionDate: string | null;
  employeeCompletedAt: string | null;
  managerCompleted: boolean;
  managerCompletionDate: string | null;
  managerCompletedAt: string | null;
  finalisedAt: string | null;
  dueDate: string | null;
  status: AnnualReviewStatus;
};

export type AnnualReviewReport = {
  reviewYear: string;
  asOfDate: string;
  generatedAt: string;
  availableYears: string[];
  includesInactive: boolean;
  rows: AnnualReviewReportRow[];
  summary: {
    totalEmployees: number;
    triggered: number;
    notTriggered: number;
    notEligible: number;
    employeeCompleted: number;
    managerCompleted: number;
    awaitingBoth: number;
    awaitingEmployee: number;
    awaitingManager: number;
    awaitingFinalisation: number;
    finalised: number;
  };
};

export type AnnualReviewReportResult =
  | { ok: true; report: AnnualReviewReport }
  | { ok: false; message: string };

export type AnnualReviewExcelResult =
  | { ok: true; fileName: string; base64: string }
  | { ok: false; message: string };
