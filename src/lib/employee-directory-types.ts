export type EmployeeDirectoryCompany = "mam" | "equipsy";
export type EmployeeLaptopSupply = "" | "own_laptop" | "mam_laptop";

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
  archiveReason: string;
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
  archiveReason: string;
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
