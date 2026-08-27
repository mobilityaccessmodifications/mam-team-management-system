"use client";

import {
  AlertCircle,
  Barcode,
  Download,
  Laptop,
  LoaderCircle,
  PackagePlus,
  Printer,
  RefreshCw,
  Search,
  Pencil,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  createItAsset,
  listItAssetAssignees,
  listItAssets,
  reassignItAsset,
  retireItAsset,
} from "@/app/assets/actions";
import styles from "@/components/asset-register.module.css";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import {
  IT_ASSET_TYPES,
  type CreateItAssetInput,
  type ItAsset,
  type ItAssetAssignee,
  type ItAssetType,
} from "@/lib/it-asset-types";

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

type BarcodeAction = "download" | "print";

function assetTypeLabel(type: ItAssetType) {
  return assetTypeLabels[type];
}

function assetDescription(asset: ItAsset) {
  const model = [asset.manufacturer, asset.model].filter(Boolean).join(" · ");
  return model || assetTypeLabel(asset.assetType);
}

function custodianDescription(asset: ItAsset) {
  if (!asset.assignedTo) return "Assignment required";
  return asset.assignedTo.positionTitle
    ? `${asset.assignedTo.fullName} · ${asset.assignedTo.positionTitle}`
    : asset.assignedTo.fullName;
}

function assigneeDescription(assignee: ItAssetAssignee) {
  return [assignee.fullName, assignee.positionTitle, assignee.teamName]
    .filter(Boolean)
    .join(" · ");
}

function safeFileName(assetCode: string) {
  return assetCode.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-");
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
  }[character] ?? character));
}

function barcodeOptions(value: string) {
  return {
    bcid: "code128",
    text: value,
    scale: 3,
    height: 14,
    includetext: true,
    textxalign: "center" as const,
    textsize: 11,
    paddingwidth: 8,
    paddingheight: 6,
    backgroundcolor: "FFFFFF",
    barcolor: "1D2B29",
    textcolor: "1D2B29",
  };
}

async function renderBarcode(value: string, canvas: HTMLCanvasElement) {
  const bwipjs = await import("@bwip-js/browser");
  bwipjs.toCanvas(canvas, barcodeOptions(value));
}

async function createBarcodeCanvas(value: string) {
  const canvas = document.createElement("canvas");
  await renderBarcode(value, canvas);
  return canvas;
}

async function barcodePng(value: string) {
  const canvas = await createBarcodeCanvas(value);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The barcode image could not be created."));
    }, "image/png");
  });
}

function BarcodePreview({ value }: { value: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    const canvas = canvasRef.current;
    if (!canvas) return;

    void renderBarcode(value, canvas)
      .then(() => {
        if (!disposed) setError("");
      })
      .catch(() => {
        if (!disposed) setError("The barcode preview could not be generated.");
      });

    return () => {
      disposed = true;
    };
  }, [value]);

  if (error) return <p className={styles.barcodeError} role="alert">{error}</p>;
  return <canvas className={styles.barcodeCanvas} ref={canvasRef} role="img" aria-label={`Barcode ${value}`} />;
}

function AssetLabelModal({
  asset,
  onClose,
  onAddAnother,
}: {
  asset: ItAsset;
  onClose: () => void;
  onAddAnother: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const [busyAction, setBusyAction] = useState<BarcodeAction | null>(null);
  const [actionError, setActionError] = useState("");
  useDialogFocus(true, dialogRef, initialFocusRef, onClose);

  async function downloadLabel() {
    setBusyAction("download");
    setActionError("");
    try {
      const blob = await barcodePng(asset.barcodeValue);
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `${safeFileName(asset.assetCode)}-barcode.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 0);
    } catch {
      setActionError("The barcode image could not be downloaded. Try again.");
    } finally {
      setBusyAction(null);
    }
  }

  async function printLabel() {
    // Open the window synchronously from the click, before barcode rendering,
    // so normal popup protections do not block the print label workflow.
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      setActionError("Your browser blocked the label window. Allow pop-ups, then try again.");
      return;
    }

    printWindow.opener = null;
    setBusyAction("print");
    setActionError("");
    try {
      const canvas = await createBarcodeCanvas(asset.barcodeValue);
      const image = canvas.toDataURL("image/png");
      const assetCode = escapeHtml(asset.assetCode);
      const type = escapeHtml(assetTypeLabel(asset.assetType));
      printWindow.document.open();
      printWindow.document.write(`<!doctype html>
        <html lang="en"><head><meta charset="utf-8"><title>${assetCode} label</title>
        <style>
          @page { size: 62mm 38mm; margin: 0; }
          * { box-sizing: border-box; }
          html, body { margin: 0; padding: 0; background: #fff; color: #1d2b29; font-family: Arial, sans-serif; }
          .label { width: 62mm; min-height: 38mm; padding: 4mm; border: .35mm solid #1d2b29; display: grid; align-content: center; gap: 1.6mm; }
          .eyebrow { margin: 0; color: #bc4d19; font-size: 7pt; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
          h1 { margin: 0; font-family: monospace; font-size: 12pt; letter-spacing: .035em; }
          .type { margin: 0; color: #526260; font-size: 8pt; }
          img { width: 100%; height: auto; display: block; image-rendering: crisp-edges; }
        </style></head><body><main class="label">
          <p class="eyebrow">MAM IT asset</p><h1>${assetCode}</h1><p class="type">${type}</p>
          <img src="${image}" alt="Barcode ${assetCode}">
        </main><script>window.addEventListener('load', function () { window.setTimeout(function () { window.focus(); window.print(); }, 180); });</script></body></html>`);
      printWindow.document.close();
    } catch {
      printWindow.close();
      setActionError("The print label could not be generated. Try again.");
    } finally {
      setBusyAction(null);
    }
  }

  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className={styles.labelModal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="asset-label-title" tabIndex={-1}>
      <header>
        <div><span>Device added</span><h2 id="asset-label-title">Barcode label ready</h2></div>
        <button type="button" onClick={onClose} aria-label="Close barcode label"><X size={19} /></button>
      </header>
      <div className={styles.labelPreview}>
        <div><span>MAM IT asset</span><strong>{asset.assetCode}</strong><small>{assetTypeLabel(asset.assetType)} · {asset.assignedTo?.fullName ?? "Assignment required"}</small></div>
        <BarcodePreview value={asset.barcodeValue} />
      </div>
      <p className={styles.labelPrivacy}>This label encodes only the MAM asset number. It does not contain staff, account or recovery details.</p>
      {actionError ? <p className={styles.inlineError} role="alert"><AlertCircle size={15} />{actionError}</p> : null}
      <footer>
        <button className={styles.secondaryAction} type="button" onClick={onAddAnother}>Add another</button>
        <div>
          <button className={styles.secondaryAction} type="button" onClick={() => void printLabel()} disabled={busyAction !== null}>
            {busyAction === "print" ? <LoaderCircle className={styles.spinner} size={16} /> : <Printer size={16} />}
            Print label
          </button>
          <button className={styles.primaryAction} type="button" onClick={() => void downloadLabel()} disabled={busyAction !== null} ref={initialFocusRef}>
            {busyAction === "download" ? <LoaderCircle className={styles.spinner} size={16} /> : <Download size={16} />}
            Download PNG
          </button>
        </div>
      </footer>
    </section>
  </div>;
}

function AddDeviceModal({
  assignees,
  onClose,
  onCreated,
}: {
  assignees: ItAssetAssignee[];
  onClose: () => void;
  onCreated: (asset: ItAsset) => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const assigneeRef = useRef<HTMLSelectElement>(null);
  const typeRef = useRef<HTMLSelectElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const closeWhenReady = useCallback(() => {
    if (!saving) onClose();
  }, [onClose, saving]);
  useDialogFocus(true, dialogRef, assigneeRef, closeWhenReady);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const data = new FormData(event.currentTarget);
    const assetType = String(data.get("assetType") ?? "");
    const assignedPersonId = String(data.get("assignedPersonId") ?? "");
    if (!IT_ASSET_TYPES.includes(assetType as ItAssetType)) {
      setError("Choose the type of device you are adding.");
      typeRef.current?.focus();
      return;
    }
    if (!assignees.some((assignee) => assignee.personId === assignedPersonId)) {
      setError("Choose the employee responsible for this device.");
      assigneeRef.current?.focus();
      return;
    }

    const input: CreateItAssetInput = {
      assetType: assetType as ItAssetType,
      assignedPersonId,
      manufacturer: String(data.get("manufacturer") ?? ""),
      model: String(data.get("model") ?? ""),
      serialNumber: String(data.get("serialNumber") ?? ""),
    };
    setSaving(true);
    setError("");
    try {
      onCreated(await createItAsset(input));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The device could not be added. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeWhenReady()}>
    <section className={styles.modal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="add-device-title" tabIndex={-1}>
      <header>
        <div><span>IT asset register</span><h2 id="add-device-title">Add device</h2><p>Record the accountable employee first; MAM then generates the permanent barcode number.</p></div>
        <button type="button" onClick={closeWhenReady} disabled={saving} aria-label="Close add device"><X size={19} /></button>
      </header>
      <form onSubmit={submit}>
        <label>
          <span>Assigned to <b aria-hidden="true">*</b></span>
          <select name="assignedPersonId" ref={assigneeRef} required defaultValue="" disabled={!assignees.length}>
            <option value="" disabled>{assignees.length ? "Select employee" : "No active employees available"}</option>
            {assignees.map((assignee) => <option key={assignee.personId} value={assignee.personId}>{assigneeDescription(assignee)}</option>)}
          </select>
        </label>
        <label>
          <span>Device type <b aria-hidden="true">*</b></span>
          <select name="assetType" ref={typeRef} required defaultValue="">
            <option value="" disabled>Select device type</option>
            {IT_ASSET_TYPES.map((type) => <option key={type} value={type}>{assetTypeLabel(type)}</option>)}
          </select>
        </label>
        <div className={styles.formGrid}>
          <label><span>Manufacturer <small>Optional</small></span><input name="manufacturer" maxLength={80} placeholder="Apple, Dell, Logitech…" /></label>
          <label><span>Model <small>Optional</small></span><input name="model" maxLength={120} placeholder="MacBook Air, iPhone 16…" /></label>
        </div>
        <label><span>Serial number <small>Optional</small></span><input name="serialNumber" maxLength={128} placeholder="Enter the manufacturer serial number" /></label>
        <p className={styles.formHelp}><Barcode size={15} /> MAM creates a unique asset number and Code 128 barcode after you save. No password, passcode or account information is stored here.</p>
        {error ? <p className={styles.inlineError} role="alert"><AlertCircle size={15} />{error}</p> : null}
        <footer>
          <button className={styles.secondaryAction} type="button" onClick={closeWhenReady} disabled={saving}>Cancel</button>
          <button className={styles.primaryAction} type="submit" disabled={saving || !assignees.length}>
            {saving ? <LoaderCircle className={styles.spinner} size={16} /> : <PackagePlus size={16} />}
            {saving ? "Creating barcode…" : "Create device"}
          </button>
        </footer>
      </form>
    </section>
  </div>;
}

function ChangeDeviceOwnerModal({
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
  const assigneeRef = useRef<HTMLSelectElement>(null);
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
    <section className={styles.modal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="change-device-owner-title" tabIndex={-1}>
      <header>
        <div><span>Device custody</span><h2 id="change-device-owner-title">Change device owner</h2><p>{asset.assetCode} · {assetTypeLabel(asset.assetType)}</p></div>
        <button type="button" onClick={closeWhenReady} disabled={saving} aria-label="Close change device owner"><X size={19} /></button>
      </header>
      <form onSubmit={submit}>
        <div className={styles.currentCustodian}><UsersRound size={16} /><div><span>Currently assigned to</span><strong>{asset.assignedTo ? custodianDescription(asset) : "Assignment required"}</strong></div></div>
        <label>
          <span>Assigned to <b aria-hidden="true">*</b></span>
          <select name="assignedPersonId" ref={assigneeRef} required defaultValue={asset.assignedTo?.personId ?? ""} disabled={!assignees.length}>
            <option value="" disabled>Select employee</option>
            {assignees.map((assignee) => <option key={assignee.personId} value={assignee.personId}>{assigneeDescription(assignee)}</option>)}
          </select>
        </label>
        <p className={styles.formHelp}><Pencil size={15} /> Changing the employee transfers accountability for this device. The barcode number and audit history stay unchanged.</p>
        {error ? <p className={styles.inlineError} role="alert"><AlertCircle size={15} />{error}</p> : null}
        <footer>
          <button className={styles.secondaryAction} type="button" onClick={closeWhenReady} disabled={saving}>Cancel</button>
          <button className={styles.primaryAction} type="submit" disabled={saving || !assignees.length}>
            {saving ? <LoaderCircle className={styles.spinner} size={16} /> : <Pencil size={16} />}
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
    <section className={styles.modal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="remove-device-title" tabIndex={-1}>
      <header>
        <div><span>Remove device</span><h2 id="remove-device-title">Remove this device?</h2><p>{asset.assetCode} · {assetTypeLabel(asset.assetType)}</p></div>
        <button type="button" onClick={closeWhenReady} disabled={saving} aria-label="Close remove device"><X size={19} /></button>
      </header>
      <div className={styles.modalBody}>
        <p>This removes the device from the active register. Its barcode and assignment audit remain safely retained for record keeping.</p>
        <div className={styles.currentCustodian}><UsersRound size={16} /><div><span>Last assigned to</span><strong>{asset.assignedTo ? custodianDescription(asset) : "Assignment required"}</strong></div></div>
        {error ? <p className={styles.inlineError} role="alert"><AlertCircle size={15} />{error}</p> : null}
      </div>
      <footer className={styles.modalFooter}>
        <button className={styles.secondaryAction} type="button" onClick={closeWhenReady} disabled={saving} ref={cancelRef}>Keep device</button>
        <button className={styles.dangerAction} type="button" onClick={() => void removeDevice()} disabled={saving}>
          {saving ? <LoaderCircle className={styles.spinner} size={16} /> : <Trash2 size={16} />}
          {saving ? "Removing…" : "Yes, remove device"}
        </button>
      </footer>
    </section>
  </div>;
}

export function AssetRegister() {
  const [assets, setAssets] = useState<ItAsset[]>([]);
  const [assignees, setAssignees] = useState<ItAssetAssignee[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [showAddDevice, setShowAddDevice] = useState(false);
  const [newAsset, setNewAsset] = useState<ItAsset | null>(null);
  const [assignmentTarget, setAssignmentTarget] = useState<ItAsset | null>(null);
  const [removalTarget, setRemovalTarget] = useState<ItAsset | null>(null);
  const [query, setQuery] = useState("");
  const [barcodeAction, setBarcodeAction] = useState<{ id: string; action: BarcodeAction } | null>(null);
  const [rowError, setRowError] = useState("");
  const [notice, setNotice] = useState("");

  const loadAssets = useCallback(async () => {
    setLoading(true);
    try {
      const [nextAssets, nextAssignees] = await Promise.all([
        listItAssets(),
        listItAssetAssignees(),
      ]);
      setAssets(nextAssets);
      setAssignees(nextAssignees);
      setLoadError("");
    } catch (reason) {
      setAssets([]);
      setLoadError(reason instanceof Error ? reason.message : "IT assets could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialLoadTimer = window.setTimeout(() => void loadAssets(), 0);
    return () => window.clearTimeout(initialLoadTimer);
  }, [loadAssets]);

  const visibleAssets = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return assets;
    return assets.filter((asset) => [
      asset.assetCode,
      assetTypeLabel(asset.assetType),
      asset.manufacturer,
      asset.model,
      asset.serialNumber,
      asset.status,
      asset.assignedTo?.fullName,
      asset.assignedTo?.positionTitle,
      asset.assignedTo?.teamName,
    ].join(" ").toLocaleLowerCase().includes(needle));
  }, [assets, query]);

  function assetCreated(asset: ItAsset) {
    setAssets((current) => [asset, ...current]);
    setShowAddDevice(false);
    setNewAsset(asset);
    setNotice(`Device assigned to ${asset.assignedTo?.fullName ?? "the selected employee"}.`);
  }

  function assetOwnerChanged(asset: ItAsset) {
    setAssets((current) => current.map((candidate) => candidate.id === asset.id ? asset : candidate));
    setAssignmentTarget(null);
    setNotice(`${asset.assetCode} is now assigned to ${asset.assignedTo?.fullName ?? "the selected employee"}.`);
  }

  function assetRemoved(asset: ItAsset) {
    setAssets((current) => current.filter((candidate) => candidate.id !== asset.id));
    setRemovalTarget(null);
    setNotice(`${asset.assetCode} was removed from the active register.`);
  }

  async function downloadFromRow(asset: ItAsset) {
    setBarcodeAction({ id: asset.id, action: "download" });
    setRowError("");
    try {
      const blob = await barcodePng(asset.barcodeValue);
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `${safeFileName(asset.assetCode)}-barcode.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 0);
    } catch {
      setRowError("The barcode image could not be downloaded. Try again.");
    } finally {
      setBarcodeAction(null);
    }
  }

  async function printFromRow(asset: ItAsset) {
    setNewAsset(asset);
  }

  return <section className={styles.workspace} aria-labelledby="asset-register-title">
    <header className={styles.header}>
      <div>
        <span>IT asset register</span>
        <h2 id="asset-register-title">Devices and labels</h2>
      </div>
      <button className={styles.primaryAction} type="button" onClick={() => setShowAddDevice(true)}><PackagePlus size={17} /> Add device</button>
    </header>

    {notice ? <div className={styles.notice} role="status"><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss message"><X size={15} /></button></div> : null}

    <div className={styles.tools}>
      <label className={styles.searchField}>
        <Search size={17} aria-hidden="true" />
        <span className={styles.visuallyHidden}>Search assets</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search asset number, device or serial" />
      </label>
      <span className={styles.assetCount}>{assets.length} {assets.length === 1 ? "device" : "devices"}</span>
    </div>

    {rowError ? <p className={styles.inlineError} role="alert"><AlertCircle size={15} />{rowError}</p> : null}
    {loading ? <div className={styles.loadingState}><LoaderCircle className={styles.spinner} size={21} /><span>Loading IT assets…</span></div> : null}
    {!loading && loadError ? <div className={styles.errorState} role="alert"><AlertCircle size={20} aria-hidden="true" /><div><strong>IT assets could not be loaded</strong><span>{loadError}</span></div><button className={styles.secondaryAction} type="button" onClick={() => void loadAssets()} disabled={loading}><RefreshCw size={16} aria-hidden="true" /> Retry</button></div> : null}
    {!loading && !loadError && !visibleAssets.length ? <div className={styles.emptyState}><Laptop size={28} /><strong>{assets.length ? "No matching devices" : "No devices recorded yet"}</strong><span>{assets.length ? "Try another search." : "Add the first MAM device to assign it and generate its barcode label."}</span>{!assets.length ? <button className={styles.secondaryAction} type="button" onClick={() => setShowAddDevice(true)}><PackagePlus size={16} /> Add device</button> : null}</div> : null}
    {!loading && !loadError && visibleAssets.length ? <div className={styles.assetList} role="list" aria-label="IT assets">
      {visibleAssets.map((asset) => {
        const activeAction = barcodeAction?.id === asset.id ? barcodeAction.action : null;
        return <article className={styles.assetRow} key={asset.id} role="listitem">
          <div className={styles.assetIcon}><Laptop size={18} /></div>
          <div className={styles.assetIdentity}><strong>{assetTypeLabel(asset.assetType)}</strong><span>{assetDescription(asset)}</span></div>
          <div className={styles.assetCode}><span>Asset number</span><strong>{asset.assetCode}</strong></div>
          <div className={styles.assetSerial}><span>Serial number</span><strong>{asset.serialNumber || "Not recorded"}</strong></div>
          <div className={styles.assetCustodian} data-missing={!asset.assignedTo}>
            <span>Assigned to</span><strong>{custodianDescription(asset)}</strong>
          </div>
          <span className={styles.status} data-status={asset.assignedTo ? asset.status : "requires_assignment"}>{asset.assignedTo ? asset.status : "assign owner"}</span>
          <div className={styles.rowActions}>
            <button type="button" onClick={() => setAssignmentTarget(asset)} disabled={activeAction !== null} aria-label={`Change ${asset.assetCode} owner`}>
              <Pencil size={15} /><span>{asset.assignedTo ? "Owner" : "Assign"}</span>
            </button>
            <button type="button" onClick={() => void downloadFromRow(asset)} disabled={activeAction !== null} aria-label={`Download ${asset.assetCode} barcode`}>
              {activeAction === "download" ? <LoaderCircle className={styles.spinner} size={15} /> : <Download size={15} />}<span>Download</span>
            </button>
            <button type="button" onClick={() => void printFromRow(asset)} disabled={activeAction !== null} aria-label={`Open ${asset.assetCode} barcode label`}>
              <Printer size={15} /><span>Label</span>
            </button>
            <button type="button" className={styles.removeAction} onClick={() => setRemovalTarget(asset)} disabled={activeAction !== null} aria-label={`Remove ${asset.assetCode} device`}>
              <Trash2 size={15} /><span>Remove</span>
            </button>
          </div>
        </article>;
      })}
    </div> : null}

    {showAddDevice ? <AddDeviceModal assignees={assignees} onClose={() => setShowAddDevice(false)} onCreated={assetCreated} /> : null}
    {newAsset ? <AssetLabelModal asset={newAsset} onClose={() => setNewAsset(null)} onAddAnother={() => { setNewAsset(null); setShowAddDevice(true); }} /> : null}
    {assignmentTarget ? <ChangeDeviceOwnerModal asset={assignmentTarget} assignees={assignees} onClose={() => setAssignmentTarget(null)} onSaved={assetOwnerChanged} /> : null}
    {removalTarget ? <RemoveDeviceModal asset={removalTarget} onClose={() => setRemovalTarget(null)} onRemoved={assetRemoved} /> : null}
  </section>;
}
