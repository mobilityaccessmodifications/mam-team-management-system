"use client";

import {
  AlertCircle,
  Laptop,
  LoaderCircle,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  listItAssetAssignees,
  listItAssetsForEmployee,
  reassignItAsset,
  retireItAsset,
} from "@/app/assets/actions";
import styles from "@/components/employee-device-assignments.module.css";
import { EmployeePicker } from "@/components/employee-picker";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import type { ItAsset, ItAssetAssignee, ItAssetType } from "@/lib/it-asset-types";

const assetTypeLabels: Record<ItAssetType, string> = {
  laptop: "Laptop",
  desktop: "Desktop computer",
  iphone: "iPhone",
  ipad: "iPad",
  tablet: "Tablet",
  mobile_phone: "Mobile phone",
  monitor: "Monitor",
  keyboard: "Keyboard",
  mouse: "Mouse",
  sim: "SIM / eSIM",
  other: "Other device",
};

function assetTypeLabel(type: ItAssetType) {
  return assetTypeLabels[type];
}

function assetDescription(asset: ItAsset) {
  const model = [asset.manufacturer, asset.model].filter(Boolean).join(" · ");
  return model || assetTypeLabel(asset.assetType);
}

function ChangeOwnerModal({
  asset,
  assignees,
  onClose,
  onSaved,
}: {
  asset: ItAsset;
  assignees: ItAssetAssignee[];
  onClose: () => void;
  onSaved: (asset: ItAsset) => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const assigneeRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const closeWhenReady = useCallback(() => {
    if (!saving) onClose();
  }, [onClose, saving]);
  useDialogFocus(true, dialogRef, assigneeRef, closeWhenReady);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
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

    setSaving(true);
    setError("");
    try {
      onSaved(await reassignItAsset({
        assetId: asset.id,
        assignedPersonId,
        version: asset.version,
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The device owner could not be changed. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeWhenReady()}>
    <section className={`${styles.modal} ${styles.modalWithPicker}`} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="directory-device-owner-title" tabIndex={-1}>
      <header>
        <div><span>Device custody</span><h4 id="directory-device-owner-title">Change device owner</h4><p>{asset.assetCode} · {assetTypeLabel(asset.assetType)}</p></div>
        <button type="button" onClick={closeWhenReady} disabled={saving} aria-label="Close change device owner"><X size={17} /></button>
      </header>
      <form onSubmit={submit}>
        <label>
          <span>Assigned to <b aria-hidden="true">*</b></span>
          <EmployeePicker assignees={assignees} defaultValue={asset.assignedTo?.personId ?? ""} disabled={!assignees.length} inputRef={assigneeRef} />
        </label>
        <p className={styles.modalHelp}>Changing the employee transfers accountability for this device. The asset number, barcode and audit record stay unchanged.</p>
        {error ? <p className={styles.modalError} role="alert"><AlertCircle size={15} />{error}</p> : null}
        <footer>
          <button className={styles.secondaryAction} type="button" onClick={closeWhenReady} disabled={saving}>Cancel</button>
          <button className={styles.primaryAction} type="submit" disabled={saving || !assignees.length}>
            {saving ? <LoaderCircle className={styles.spinner} size={15} /> : <Pencil size={15} />}
            {saving ? "Updating…" : "Save owner"}
          </button>
        </footer>
      </form>
    </section>
  </div>;
}

function RemoveDeviceModal({
  asset,
  onClose,
  onRemoved,
}: {
  asset: ItAsset;
  onClose: () => void;
  onRemoved: (asset: ItAsset) => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const closeWhenReady = useCallback(() => {
    if (!saving) onClose();
  }, [onClose, saving]);
  useDialogFocus(true, dialogRef, cancelRef, closeWhenReady);

  async function removeDevice() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      onRemoved(await retireItAsset({ assetId: asset.id, version: asset.version }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The device could not be removed. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeWhenReady()}>
    <section className={styles.modal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="directory-remove-device-title" tabIndex={-1}>
      <header>
        <div><span>Remove device</span><h4 id="directory-remove-device-title">Remove this device?</h4><p>{asset.assetCode} · {assetTypeLabel(asset.assetType)}</p></div>
        <button type="button" onClick={closeWhenReady} disabled={saving} aria-label="Close remove device"><X size={17} /></button>
      </header>
      <div className={styles.modalBody}>
        <p>This removes the device from the active register. Its barcode and assignment audit remain safely retained for record keeping.</p>
        {error ? <p className={styles.modalError} role="alert"><AlertCircle size={15} />{error}</p> : null}
      </div>
      <footer className={styles.modalFooter}>
        <button className={styles.secondaryAction} type="button" onClick={closeWhenReady} disabled={saving} ref={cancelRef}>Keep device</button>
        <button className={styles.dangerAction} type="button" onClick={() => void removeDevice()} disabled={saving}>
          {saving ? <LoaderCircle className={styles.spinner} size={15} /> : <Trash2 size={15} />}
          {saving ? "Removing…" : "Yes, remove device"}
        </button>
      </footer>
    </section>
  </div>;
}

/**
 * Live System Admin device inventory for the selected HR profile. It uses the
 * IT asset RPC boundary rather than the broad employee-directory draft so
 * hardware custody cannot be silently changed by a profile save.
 */
export function EmployeeDeviceAssignments({
  personId,
  personName,
}: {
  personId: string;
  personName: string;
}) {
  const [assets, setAssets] = useState<ItAsset[]>([]);
  const [assignees, setAssignees] = useState<ItAssetAssignee[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [assignmentTarget, setAssignmentTarget] = useState<ItAsset | null>(null);
  const [removalTarget, setRemovalTarget] = useState<ItAsset | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextAssets, nextAssignees] = await Promise.all([
        listItAssetsForEmployee(personId),
        listItAssetAssignees(),
      ]);
      setAssets(nextAssets);
      setAssignees(nextAssignees);
      setLoadError("");
    } catch (reason) {
      setAssets([]);
      setLoadError(reason instanceof Error ? reason.message : "Registered devices could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [personId]);

  useEffect(() => {
    const loadTimer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(loadTimer);
  }, [load]);

  function ownerChanged(asset: ItAsset) {
    setAssignmentTarget(null);
    setAssets((current) => asset.assignedTo?.personId === personId
      ? current.map((candidate) => candidate.id === asset.id ? asset : candidate)
      : current.filter((candidate) => candidate.id !== asset.id));
    setNotice(`${asset.assetCode} is now assigned to ${asset.assignedTo?.fullName ?? "the selected employee"}.`);
  }

  function assetRemoved(asset: ItAsset) {
    setRemovalTarget(null);
    setAssets((current) => current.filter((candidate) => candidate.id !== asset.id));
    setNotice(`${asset.assetCode} was removed from the active register.`);
  }

  return <fieldset className={styles.section}>
    <legend>Registered devices <small>Live IT asset register</small></legend>
    <p className={styles.intro}>Devices linked here are managed in the IT asset register. Each active device has one accountable employee.</p>

    {notice ? <div className={styles.notice} role="status"><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss message"><X size={14} /></button></div> : null}
    {loading ? <div className={styles.loadingState}><LoaderCircle className={styles.spinner} size={16} /> Loading devices…</div> : null}
    {!loading && loadError ? <div className={styles.errorState} role="alert"><AlertCircle size={16} /><span>{loadError}</span><button className={styles.secondaryAction} type="button" onClick={() => void load()}>Retry</button></div> : null}
    {!loading && !loadError && !assets.length ? <div className={styles.emptyState}><Laptop size={18} /><span>No registered devices are assigned to {personName}.</span></div> : null}
    {!loading && !loadError && assets.length ? <div className={styles.deviceList} role="list" aria-label={`${personName}'s registered devices`}>
      {assets.map((asset) => <article className={styles.deviceCard} key={asset.id} role="listitem">
        <div className={styles.deviceIcon}><Laptop size={17} /></div>
        <div className={styles.deviceCopy}><strong>{assetTypeLabel(asset.assetType)}</strong><span>{assetDescription(asset)}</span></div>
        <div className={styles.deviceCode}><span>Asset no.</span><strong>{asset.assetCode}</strong></div>
        <div className={styles.deviceSerial}><span>Serial</span><strong>{asset.serialNumber || "Not recorded"}</strong></div>
        <div className={styles.deviceActions}>
          <button className={styles.secondaryAction} type="button" onClick={() => setAssignmentTarget(asset)}><Pencil size={14} /> Change owner</button>
          <button className={styles.dangerAction} type="button" onClick={() => setRemovalTarget(asset)}><Trash2 size={14} /> Remove</button>
        </div>
      </article>)}
    </div> : null}

    {assignmentTarget ? <ChangeOwnerModal asset={assignmentTarget} assignees={assignees} onClose={() => setAssignmentTarget(null)} onSaved={ownerChanged} /> : null}
    {removalTarget ? <RemoveDeviceModal asset={removalTarget} onClose={() => setRemovalTarget(null)} onRemoved={assetRemoved} /> : null}
  </fieldset>;
}
