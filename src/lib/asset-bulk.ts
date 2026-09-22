import type { ItAsset, ReassignItAssetInput, ReturnItAssetInput } from "@/lib/it-asset-types";

export type AssetBulkChange = { action: "assign"; assignedPersonId: string } | { action: "return"; returnedOn: string };
export type AssetBulkOutcome = { updated: ItAsset[]; failed: { id: string; assetCode: string; message: string }[] };

/** Every item goes through the existing authorised, version-checked operation. */
export async function runAssetBulkEdit(
  assets: ItAsset[], change: AssetBulkChange,
  actions: { assign: (input: ReassignItAssetInput) => Promise<ItAsset>; return: (input: ReturnItAssetInput) => Promise<ItAsset> },
  progress?: (completed: number) => void,
): Promise<AssetBulkOutcome> {
  if (!assets.length || assets.length > 100 || new Set(assets.map(asset => asset.id)).size !== assets.length) {
    throw new Error("Select between 1 and 100 devices.");
  }
  const result: AssetBulkOutcome = { updated: [], failed: [] };
  for (const asset of assets) {
    try {
      const updated = change.action === "assign"
        ? await actions.assign({ assetId: asset.id, version: asset.version, assignedPersonId: change.assignedPersonId })
        : await actions.return({ assetId: asset.id, version: asset.version, returnedOn: change.returnedOn });
      result.updated.push(updated);
    } catch (error) {
      result.failed.push({ id: asset.id, assetCode: asset.assetCode, message: error instanceof Error ? error.message : "Could not save. Refresh and try again." });
    }
    progress?.(result.updated.length + result.failed.length);
  }
  return result;
}
