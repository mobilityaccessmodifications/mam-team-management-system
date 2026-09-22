export const IT_ASSET_TYPES = [
  "laptop",
  "desktop",
  "iphone",
  "ipad",
  "tablet",
  "mobile_phone",
  "monitor",
  "keyboard",
  "mouse",
  "sim",
  "other",
] as const;

export type ItAssetType = typeof IT_ASSET_TYPES[number];
export type ItAssetStatus = "available" | "assigned" | "repair" | "retired";

/** Minimal employee identity used only by the System Admin asset workflows. */
export type ItAssetAssignee = {
  personId: string;
  fullName: string;
  positionTitle: string;
  teamName: string;
  company: "mam" | "equipsy";
};

export type ItAssetCustodian = Omit<ItAssetAssignee, "company">;

/**
 * System Admin-only inventory DTO. It deliberately has no passcodes,
 * account/recovery credentials, employee address data or other secrets.
 */
export type ItAsset = {
  id: string;
  assetCode: string;
  /** Stable non-secret asset code; QR labels link to its authenticated device page. */
  barcodeValue: string;
  assetType: ItAssetType;
  manufacturer: string;
  model: string;
  serialNumber: string;
  status: ItAssetStatus;
  /** The current accountable employee. Available hardware has no current owner. */
  assignedTo: ItAssetCustodian | null;
  /** Database-owned date that the current custody period began. */
  assignedOn: string | null;
  /** Most recent date the hardware was physically returned to MAM. */
  lastReturnedOn: string | null;
  createdAt: string;
  version: number;
};

/** System Admin-only custody history used for audit and register exports. */
export type ItAssetCustodyHistory = {
  id: string;
  assetId: string;
  assetCode: string;
  assetType: ItAssetType;
  manufacturer: string;
  model: string;
  serialNumber: string;
  person: ItAssetCustodian;
  assignedOn: string;
  returnedOn: string | null;
};

/**
 * Safe self-service device projection for an employee's own directory view.
 * It intentionally omits assignee metadata and every credential/private field.
 */
export type EmployeeItAsset = {
  id: string;
  assetCode: string;
  barcodeValue: string;
  assetType: ItAssetType;
  manufacturer: string;
  model: string;
  serialNumber: string;
  status: Exclude<ItAssetStatus, "retired">;
  createdAt: string;
  version: number;
};

export type CreateItAssetInput = {
  assetType: ItAssetType;
  assignedPersonId: string;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
};

export type ReassignItAssetInput = {
  assetId: string;
  assignedPersonId: string;
  version: number;
};

export type ReturnItAssetInput = {
  assetId: string;
  version: number;
  /** ISO calendar date of the physical hardware return. */
  returnedOn: string;
};

export type RetireItAssetInput = {
  assetId: string;
  version: number;
};
