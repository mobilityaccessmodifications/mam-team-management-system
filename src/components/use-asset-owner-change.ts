import { type FormEvent, type RefObject, useCallback, useRef, useState } from "react";

import { reassignItAsset } from "@/app/assets/actions";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import type { ItAsset, ItAssetAssignee } from "@/lib/it-asset-types";

/** Shared by the asset register and the employee's device panel. */
export function useAssetOwnerChange({
  asset,
  assignees,
  onClose,
  onSaved,
  fallbackFocusRef = null,
}: {
  asset: ItAsset;
  assignees: ItAssetAssignee[];
  onClose: () => void;
  onSaved: (asset: ItAsset) => void;
  fallbackFocusRef?: RefObject<HTMLElement | null> | null;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const assigneeRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const closeWhenReady = useCallback(() => {
    if (!submittingRef.current) onClose();
  }, [onClose]);
  useDialogFocus(true, dialogRef, assigneeRef, closeWhenReady, fallbackFocusRef);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A ref also prevents two submissions before React renders the busy state.
    if (submittingRef.current) return;
    const assignedPersonId = String(new FormData(event.currentTarget).get("assignedPersonId") ?? "");
    if (!assignees.some((assignee) => assignee.personId === assignedPersonId)) {
      setError("Choose the employee responsible for this device.");
      assigneeRef.current?.focus();
      return;
    }
    if (assignedPersonId === asset.assignedTo?.personId) {
      onClose();
      return;
    }

    submittingRef.current = true;
    setSaving(true);
    setError("");
    try {
      onSaved(await reassignItAsset({ assetId: asset.id, assignedPersonId, version: asset.version }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The device owner could not be changed. Try again.");
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  }

  return { dialogRef, assigneeRef, saving, error, closeWhenReady, submit };
}
