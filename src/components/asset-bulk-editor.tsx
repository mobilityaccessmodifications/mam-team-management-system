"use client";

import { useCallback, useRef, useState, type FormEvent, type RefObject } from "react";
import { X } from "lucide-react";
import { reassignItAsset, returnItAsset } from "@/app/assets/actions";
import { EmployeePicker } from "@/components/employee-picker";
import { ModalBackdrop } from "@/components/ui/modal-backdrop";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import { runAssetBulkEdit, type AssetBulkOutcome } from "@/lib/asset-bulk";
import type { ItAsset, ItAssetAssignee } from "@/lib/it-asset-types";
import styles from "@/components/asset-register.module.css";

export function AssetBulkEditor({ assets, assignees, fallbackFocusRef, onClose, onSaved }: {
  assets: ItAsset[]; assignees: ItAssetAssignee[];
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void; onSaved: (result: AssetBulkOutcome) => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const initial = useRef<HTMLSelectElement>(null);
  const inFlight = useRef(false);
  const [action, setAction] = useState<"assign" | "return">("assign");
  const [saving, setSaving] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AssetBulkOutcome | null>(null);
  const close = useCallback(() => { if (!inFlight.current) onClose(); }, [onClose]);
  useDialogFocus(true, dialog, initial, close, fallbackFocusRef);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || result) return;
    const fields = new FormData(event.currentTarget);
    const assignedPersonId = String(fields.get("assignedPersonId") ?? "");
    const returnedOn = String(fields.get("returnedOn") ?? "");
    if (action === "assign" && !assignees.some(person => person.personId === assignedPersonId)) {
      setError("Choose an owner."); return;
    }
    inFlight.current = true; setSaving(true); setError("");
    try {
      const outcome = await runAssetBulkEdit(assets, action === "assign" ? { action, assignedPersonId } : { action, returnedOn }, { assign: reassignItAsset, return: returnItAsset }, setCompleted);
      setResult(outcome); onSaved(outcome);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save devices."); }
    finally { inFlight.current = false; setSaving(false); }
  }
  return <ModalBackdrop className={styles.modalBackdrop} onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className={`${styles.modal} ${styles.modalWithPicker}`} ref={dialog} role="dialog" aria-modal="true" aria-labelledby="bulk-device-title" tabIndex={-1}>
      <header><div><h2 id="bulk-device-title">Edit {assets.length} devices</h2></div><button type="button" onClick={close} disabled={saving} aria-label="Close bulk device editor"><X size={19} /></button></header>
      <form onSubmit={submit}>
        <div className={styles.bulkAssetList}>{assets.map(asset => <span key={asset.id}>{asset.assetCode}</span>)}</div>
        {!result ? <>
          <label><span>Change</span><select ref={initial} value={action} onChange={event => setAction(event.target.value as "assign" | "return")} disabled={saving}><option value="assign">Owner</option><option value="return" disabled={!assets.every(asset => asset.assignedTo)}>Record return</option></select></label>
          {action === "assign" ? <label><span>Assigned to</span><EmployeePicker assignees={assignees} disabled={saving} /></label> : <label><span>Returned on</span><input name="returnedOn" type="date" required disabled={saving} /></label>}
        </> : <div role="status"><strong>{result.updated.length} updated{result.failed.length ? ` · ${result.failed.length} not confirmed` : ""}</strong>{result.failed.length ? <ul className={styles.bulkFailures}>{result.failed.map(item => <li key={item.id}><strong>{item.assetCode}</strong> — {item.message}</li>)}</ul> : null}</div>}
        {error ? <p className={styles.inlineError} role="alert">{error}</p> : null}
        {saving ? <p role="status">Saving {completed} of {assets.length}…</p> : null}
        <footer><button type="button" className={styles.secondaryAction} disabled={saving} onClick={close}>{result ? "Done" : "Cancel"}</button>{!result ? <button type="submit" className={styles.primaryAction} disabled={saving}>{saving ? "Saving…" : `Save ${assets.length} devices`}</button> : null}</footer>
      </form>
    </section>
  </ModalBackdrop>;
}
