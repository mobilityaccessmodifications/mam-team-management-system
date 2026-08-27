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
  createdAt: string;
  version: number;
};

export type CreateItAssetInput = {
  assetType: ItAssetType;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
};
