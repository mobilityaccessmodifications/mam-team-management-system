"use client";

import { ModalBackdrop } from "@/components/ui/modal-backdrop";

import {
  AlertCircle,
  CalendarCheck2,
  Laptop,
  LoaderCircle,
  Pencil,
  Trash2,
  Undo2,
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
  returnItAsset,
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

function formatDate(value: string | null) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function melbourneToday() {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
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

  return <ModalBackdrop className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeWhenReady()}>
    <section className={`${styles.modal} ${styles.modalWithPicker}`} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="directory-device-owner-title" tabIndex={-1}>
      <header>
        <div><h4 id="directory-device-owner-title">Change device owner</h4><p>{asset.assetCode} · {assetTypeLabel(asset.assetType)}</p></div>
        <button type="button" onClick={closeWhenReady} disabled={saving} aria-label="Close change device owner"><X size={17} /></button>
      </header>
      <form onSubmit={submit}>
        <label>
          <span>Assigned to <b aria-hidden="true">*</b></span>
          <EmployeePicker assignees={assignees} defaultValue={asset.assignedTo?.personId ?? ""} disabled={!assignees.length} inputRef={assigneeRef} />
        </label>
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
  </ModalBackdrop>;
}

function ReturnDeviceModal({
  asset,
  onClose,
  onReturned,
}: {
  asset: ItAsset;
  onClose: () => void;
  onReturned: (asset: ItAsset, returnedOn: string) => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const returnedOnRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const closeWhenReady = useCallback(() => {
    if (!saving) onClose();
  }, [onClose, saving]);
  useDialogFocus(true, dialogRef, returnedOnRef, closeWhenReady);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const returnedOn = String(new FormData(event.currentTarget).get("returnedOn") ?? "");
    if (!returnedOn) {
      setError("Choose the date the hardware was returned.");
      returnedOnRef.current?.focus();
      return;
    }
    setSaving(true);
    setError("");
    try {
      onReturned(await returnItAsset({
        assetId: asset.id,
        version: asset.version,
        returnedOn,
      }), returnedOn);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The hardware return could not be recorded. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return <ModalBackdrop className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeWhenReady()}>
    <section className={styles.modal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="directory-return-device-title" tabIndex={-1}>
      <header>
        <div><h4 id="directory-return-device-title">Record device return</h4><p>{asset.assetCode} · {assetTypeLabel(asset.assetType)}</p></div>
        <button type="button" onClick={closeWhenReady} disabled={saving} aria-label="Close record device return"><X size={17} /></button>
      </header>
      <form onSubmit={submit}>
        <label>
          <span>Hardware returned on <b aria-hidden="true">*</b></span>
          <input ref={returnedOnRef} name="returnedOn" type="date" defaultValue={melbourneToday()} max={melbourneToday()} required />
        </label>
        <p className={styles.modalHelp}><CalendarCheck2 size={15} /> Once recorded, this device no longer blocks end employment for this employee.</p>
        {error ? <p className={styles.modalError} role="alert"><AlertCircle size={15} />{error}</p> : null}
        <footer>
          <button className={styles.secondaryAction} type="button" onClick={closeWhenReady} disabled={saving}>Cancel</button>
          <button className={styles.primaryAction} type="submit" disabled={saving}>
            {saving ? <LoaderCircle className={styles.spinner} size={15} /> : <Undo2 size={15} />}
            {saving ? "Recording…" : "Record return"}
          </button>
        </footer>
      </form>
    </section>
  </ModalBackdrop>;
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

  return <ModalBackdrop className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeWhenReady()}>
    <section className={styles.modal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="directory-remove-device-title" tabIndex={-1}>
      <header>
        <div><h4 id="directory-remove-device-title">Remove incorrect entry?</h4><p>{asset.assetCode} · {assetTypeLabel(asset.assetType)}</p></div>
        <button type="button" onClick={closeWhenReady} disabled={saving} aria-label="Close remove device"><X size={17} /></button>
      </header>
      <div className={styles.modalBody}>
        <p>Use this only for a duplicate or mistaken record. For an employee leaving or handing hardware back, record a hardware return instead so the custody timeline stays complete.</p>
        {error ? <p className={styles.modalError} role="alert"><AlertCircle size={15} />{error}</p> : null}
      </div>
      <footer className={styles.modalFooter}>
        <button className={styles.secondaryAction} type="button" onClick={closeWhenReady} disabled={saving} ref={cancelRef}>Keep device</button>
        <button className={styles.dangerAction} type="button" onClick={() => void removeDevice()} disabled={saving}>
          {saving ? <LoaderCircle className={styles.spinner} size={15} /> : <Trash2 size={15} />}
          {saving ? "Removing…" : "Remove incorrect entry"}
        </button>
      </footer>
    </section>
  </ModalBackdrop>;
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
  const [returnTarget, setReturnTarget] = useState<ItAsset | null>(null);
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

  function assetReturned(asset: ItAsset, returnedOn: string) {
    setReturnTarget(null);
    setAssets((current) => current.filter((candidate) => candidate.id !== asset.id));
    setNotice(`${asset.assetCode} was returned on ${formatDate(returnedOn)} and remains in the asset register.`);
  }

  return <fieldset className={styles.section}>
    <legend>Devices</legend>

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
        <div className={styles.deviceAssigned}><span>Assigned on</span><strong>{formatDate(asset.assignedOn)}</strong></div>
        <div className={styles.deviceActions}>
          <button className={styles.secondaryAction} type="button" onClick={() => setReturnTarget(asset)}><Undo2 size={14} /> Record return</button>
          <button className={styles.secondaryAction} type="button" onClick={() => setAssignmentTarget(asset)}><Pencil size={14} /> Change owner</button>
          <button className={styles.dangerAction} type="button" onClick={() => setRemovalTarget(asset)}><Trash2 size={14} /> Remove incorrect entry</button>
        </div>
      </article>)}
    </div> : null}

    {assignmentTarget ? <ChangeOwnerModal asset={assignmentTarget} assignees={assignees} onClose={() => setAssignmentTarget(null)} onSaved={ownerChanged} /> : null}
    {returnTarget ? <ReturnDeviceModal asset={returnTarget} onClose={() => setReturnTarget(null)} onReturned={assetReturned} /> : null}
    {removalTarget ? <RemoveDeviceModal asset={removalTarget} onClose={() => setRemovalTarget(null)} onRemoved={assetRemoved} /> : null}
  </fieldset>;
}
