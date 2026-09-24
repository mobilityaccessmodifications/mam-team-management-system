export type EmployeeDirectoryCompany = "mam" | "equipsy";
export type EmployeeLaptopSupply = "" | "own_laptop" | "mam_laptop";
export type EmployeeEmploymentType = "abn" | "casual" | "full_time" | "part_time";
export type EmployeeContractType = "permanent" | "fixed_term";
export type EmployeeWorkingWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type EmployeeWorkingDayTime = {
  weekday: EmployeeWorkingWeekday;
  startTime: string;
  endTime: string;
};

/**
 * The HR-only employee record returned by the explicitly authorised directory
 * RPC. It deliberately contains no login, password or auth-provider details.
 */
export type EmployeeDirectoryRecord = {
  personId: string;
  personVersion: number;
  detailVersion: number;
  company: EmployeeDirectoryCompany;
  isActive: boolean;
  firstName: string;
  lastName: string;
  fullName: string;
  positionTitle: string;
  teamName: string;
  managerId: string | null;
  managerName: string;
  workEmail: string;
  personalEmail: string;
  phone: string;
  country: string;
  address: string;
  dateOfBirth: string;
  startedDate: string;
  scheduledEmploymentEndDate: string;
  workingWeekdays: EmployeeWorkingWeekday[] | null;
  workingDayTimes: EmployeeWorkingDayTime[];
  archiveReason: string;
  employmentType: EmployeeEmploymentType | "";
  contractType: EmployeeContractType | "";
  hasPaidLeaveEntitlement: boolean;
  laptopSupplied: EmployeeLaptopSupply;
  laptopId: string;
  mouseId: string;
  keyboardId: string;
  assetTags: string[];
};

export type EmployeeDirectoryDraft = {
  firstName: string;
  lastName: string;
  workEmail: string;
  personalEmail: string;
  phone: string;
  positionTitle: string;
  teamName: string;
  managerId: string | null;
  country: string;
  address: string;
  dateOfBirth: string;
  startedDate: string;
  scheduledEmploymentEndDate: string;
  workingWeekdays: EmployeeWorkingWeekday[] | null;
  workingDayTimes: EmployeeWorkingDayTime[];
  archiveReason: string;
  employmentType: EmployeeEmploymentType | "";
  contractType: EmployeeContractType | "";
  laptopSupplied: EmployeeLaptopSupply;
  laptopId: string;
  mouseId: string;
  keyboardId: string;
  assetTags: string[];
  company: EmployeeDirectoryCompany;
  isActive: boolean;
};

export type CreateEmployeeDirectoryInput = EmployeeDirectoryDraft;

export type UpdateEmployeeDirectoryInput = EmployeeDirectoryDraft & {
  personId: string;
  personVersion: number;
  detailVersion: number;
};

export type EmployeeDirectoryMutationResult = {
  record: EmployeeDirectoryRecord;
};

/**
 * Work-directory record available to a manager for their own active team
 * only. It deliberately excludes private contact details, employment
 * lifecycle data and equipment/asset fields.
 */
export type ManagedEmployeeDirectoryRecord = {
  personId: string;
  personVersion: number;
  detailVersion: number;
  company: EmployeeDirectoryCompany;
  isActive: true;
  firstName: string;
  lastName: string;
  fullName: string;
  positionTitle: string;
  teamName: string;
  managerName: string;
  workEmail: string;
};

/** Only these operational work-directory fields may be changed by a manager. */
export type ManagedEmployeeDirectoryDraft = Pick<
  ManagedEmployeeDirectoryRecord,
  "firstName" | "lastName" | "workEmail" | "positionTitle" | "teamName"
>;

export type UpdateManagedEmployeeDirectoryInput = ManagedEmployeeDirectoryDraft & {
  personId: string;
  personVersion: number;
  detailVersion: number;
  /**
   * A System Admin may safely exercise the selected manager's scope through
   * Change profile. The server ignores this unless the caller is a System
   * Admin and the selected profile is an active manager.
   */
  previewManagerPersonId?: string;
};

export type ManagedEmployeeDirectoryMutationResult = {
  record: ManagedEmployeeDirectoryRecord;
};
