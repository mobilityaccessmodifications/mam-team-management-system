export type PayrollImportMatchStatus = "linked" | "inactive" | "unmatched" | "company_mismatch" | "ambiguous";

export type PayrollImportFile = {
  name: string;
  sizeBytes: number;
  companies: Array<"mam" | "equipsy">;
  asOfDates: string[];
  employeeRows: number;
};

export type PayrollImportPreviewRow = {
  rowId: number;
  employeeName: string;
  company: "mam" | "equipsy";
  annualHours: number | null;
  sickHours: number | null;
  asOf: string;
  status: PayrollImportMatchStatus;
  linkedName: string | null;
  willApplyAnnual: boolean;
  willApplySick: boolean;
};

export type PayrollImportBatch = {
  batchId: string;
  version: number;
  status: "staged" | "committed";
  files: PayrollImportFile[];
  createdAt: string;
  committedAt: string | null;
  rows: PayrollImportPreviewRow[];
};

export type PayrollImportReminder = {
  dueOn: string;
  mamAsOf: string | null;
  equipsyAsOf: string | null;
  mamComplete: boolean;
  equipsyComplete: boolean;
  complete: boolean;
};

export type PayrollImportBatchSummary = Omit<PayrollImportBatch, "version" | "rows"> & {
  rowCount: number;
};

export type PayrollImportWorkspace = {
  canImport: true;
  canManageAccess: boolean;
  reminder: PayrollImportReminder;
  recentBatches: PayrollImportBatchSummary[];
};

export type PayrollImportAccessPerson = {
  personId: string;
  fullName: string;
  positionTitle: string;
};

export type PayrollImportAccessWorkspace = {
  people: PayrollImportAccessPerson[];
  grantedPersonIds: string[];
};
