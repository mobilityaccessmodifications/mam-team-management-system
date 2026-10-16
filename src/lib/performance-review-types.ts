export type PerformanceRole = "employee" | "manager" | "account" | "admin" | "system_admin";
export type PerformanceAudience = "employee" | "manager" | "admin";
export type PerformanceCompany = "MAM" | "Equipsy";

export type PerformanceIdentity = {
  id: string;
  name: string;
  jobTitle: string;
  company: PerformanceCompany;
  team: string;
};

export type PerformanceManagerIdentity = { id: string; name: string };
export type PerformanceActivity = { kind: string; at: string };
export type PerformanceMeeting = {
  date: string;
  time: string;
  duration: number;
  mode: "in_person" | "teams" | "phone";
  location: string;
  notes: string;
};

export type PerformanceSelfCapabilities = {
  saveSelf: boolean;
  submitSelf: boolean;
  downloadDocument: boolean;
};

export type PerformanceManagerCapabilities = {
  saveSelf: false;
  submitSelf: false;
  saveManager: boolean;
  completeManager: boolean;
  saveMeeting: boolean;
  submitReview: boolean;
  downloadDocument: boolean;
};

export type PerformanceHrCapabilities = {
  saveSelf: false;
  submitSelf: false;
  saveManager: false;
  completeManager: false;
  saveMeeting: false;
  submitReview: false;
  downloadDocument: boolean;
};

export type PerformanceSelfFields = {
  id: string;
  code: string;
  employee: PerformanceIdentity;
  manager: PerformanceManagerIdentity;
  cycle: string;
  dueDate: string;
  selfStatus: "awaiting_employee" | "manager_review";
  selfAnswers: string[];
  selfSubmittedAt: string | null;
  selfRevision: string;
  selfActivity: PerformanceActivity[];
};

export type PerformanceSelfReview = PerformanceSelfFields & {
  audience: "employee";
  capabilities: PerformanceSelfCapabilities;
};

export type PerformanceManagerFields = {
  managerAnswers: string[];
  ratings: string[];
  summary: string;
  overallRating: string;
  managerNote: string;
  managerCompletedAt: string | null;
  meeting: PerformanceMeeting | null;
  meetingHeldAt: string | null;
  finalisedAt: string | null;
  managerActivity: PerformanceActivity[];
};

export type PerformanceManagerReview = PerformanceSelfFields & PerformanceManagerFields & {
  audience: "manager";
  managerRevision: string;
  capabilities: PerformanceManagerCapabilities;
};

export type PerformanceHrReview = PerformanceSelfFields & PerformanceManagerFields & {
  audience: "admin";
  readRevision: string;
  capabilities: PerformanceHrCapabilities;
};

export type PerformanceReview = PerformanceSelfReview | PerformanceManagerReview | PerformanceHrReview;

export type PerformanceWorkspace = {
  viewerContext: {
    actorUserId: string;
    personId: string | null;
    role: PerformanceRole;
    displayName: string;
  };
  reviews: PerformanceReview[];
  startablePeople: PerformanceIdentity[];
};

export type PerformanceFailureCode =
  | "unauthenticated"
  | "forbidden"
  | "invalid"
  | "conflict"
  | "unavailable"
  | "uncertain";

export type PerformanceFailure = {
  ok: false;
  code: PerformanceFailureCode;
  uncertain: boolean;
  message: string;
};

export type PerformanceLoadResult = { ok: true; data: PerformanceWorkspace } | PerformanceFailure;

export type PerformanceStartInput = {
  operationId: string;
  employeePersonId: string;
  cycle: string;
  dueDate: string;
};

export type PerformanceSelfInput = { answers: string[] };
export type PerformanceManagerInput = {
  answers: string[];
  ratings: string[];
  summary: string;
  overallRating: string;
  managerNote: string;
};

export type PerformanceMutationInput = {
  operationId: string;
  reviewId: string;
  expectedRevision: string;
} & (
  | { command: "save_self" | "submit_self"; input: PerformanceSelfInput }
  | { command: "save_manager" | "complete_manager"; input: PerformanceManagerInput }
  | { command: "save_meeting"; input: PerformanceMeeting }
  | { command: "submit_review"; input: PerformanceMeeting & { held: true } }
);

export type PerformanceMutationResult =
  | { ok: true; committed: true; operationId: string; review: PerformanceReview }
  | PerformanceFailure;

export type PerformanceStartResult =
  | { ok: true; committed: true; operationId: string; review: PerformanceReview; existing: boolean }
  | PerformanceFailure;

export type PerformanceReconcileInput = { operationId: string; reviewId: string | null };
export type PerformanceReconcileResult =
  | { ok: true; data: { status: "committed"; review: PerformanceReview } | { status: "not_found"; review: null } }
  | PerformanceFailure;

export type PerformanceEmployeeDocument = {
  audience: "employee";
  code: string;
  cycle: string;
  employee: PerformanceIdentity;
  manager: PerformanceManagerIdentity;
  selfAnswers: string[];
};

export type PerformanceManagerDocument = {
  audience: "manager" | "admin";
  code: string;
  cycle: string;
  employee: PerformanceIdentity;
  manager: PerformanceManagerIdentity;
  selfAnswers: string[];
  managerAnswers: string[];
  ratings: string[];
  summary: string;
  overallRating: string;
  meeting: PerformanceMeeting | null;
};

export type PerformanceDocument = PerformanceEmployeeDocument | PerformanceManagerDocument;
export type PerformanceDocumentResult = { ok: true; document: PerformanceDocument } | PerformanceFailure;
