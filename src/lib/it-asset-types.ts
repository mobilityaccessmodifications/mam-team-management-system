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
  /** The exact non-secret value encoded in the Code 128 label. */
  barcodeValue: string;
  assetType: ItAssetType;
  manufacturer: string;
  model: string;
  serialNumber: string;
  status: ItAssetStatus;
  /** The current accountable employee. Legacy pre-assignment records can be null until explicitly assigned. */
  assignedTo: ItAssetCustodian | null;
  createdAt: string;
  version: number;
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

export type RetireItAssetInput = {
  assetId: string;
  version: number;
};
