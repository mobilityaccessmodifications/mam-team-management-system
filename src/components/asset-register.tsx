"use client";

import { ModalBackdrop } from "@/components/ui/modal-backdrop";
import { MobileRegisterTools } from "@/components/ui/mobile-register-tools";

import {
  AlertCircle,
  ArrowDownUp,
  Barcode,
  CalendarCheck2,
  ClipboardClock,
  Download,
  Filter,
  Laptop,
  LoaderCircle,
  PackagePlus,
  Printer,
  RefreshCw,
  Search,
  Pencil,
  Trash2,
  Undo2,
  UsersRound,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  createItAsset,
  listItAssetAssignees,
  listItAssetCustodyHistory,
  listItAssets,
  reassignItAsset,
  returnItAsset,
  retireItAsset,
} from "@/app/assets/actions";
import styles from "@/components/asset-register.module.css";
import { EmployeePicker } from "@/components/employee-picker";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import {
  IT_ASSET_TYPES,
  type CreateItAssetInput,
  type ItAsset,
  type ItAssetAssignee,
  type ItAssetCustodyHistory,
  type ItAssetStatus,
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
type SortDirection = "ascending" | "descending";
type AssetSortKey = "device" | "assetCode" | "serialNumber" | "assignedTo" | "assignedOn" | "status";
type AssetFilterKey = "assetType" | "assignedTo" | "status";

type AssetSort = {
  key: AssetSortKey;
  direction: SortDirection;
};

type FilterOption = {
  value: string;
  label: string;
};

const assetStatusLabels: Record<ItAssetStatus, string> = {
  available: "Available",
  assigned: "Assigned",
  repair: "In repair",
  retired: "Retired",
};

function assetTypeLabel(type: ItAssetType) {
  return assetTypeLabels[type];
}

function assetDescription(asset: ItAsset) {
  return [asset.manufacturer, asset.model].filter(Boolean).join(" · ");
}

function assetStatusLabel(status: ItAssetStatus) {
  return assetStatusLabels[status];
}

function assetTimingValue(asset: ItAsset) {
  return asset.assignedTo ? asset.assignedOn : asset.lastReturnedOn;
}

function compareAssetText(left: string | null | undefined, right: string | null | undefined) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.localeCompare(right, "en-AU", { numeric: true, sensitivity: "base" });
}

function custodianDescription(asset: ItAsset) {
  if (!asset.assignedTo) return "Assignment required";
  return asset.assignedTo.positionTitle
    ? `${asset.assignedTo.fullName} · ${asset.assignedTo.positionTitle}`
    : asset.assignedTo.fullName;
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
  onAddAnother?: () => void;
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

  return <ModalBackdrop className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className={styles.labelModal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="asset-label-title" tabIndex={-1}>
      <header>
        <div><h2 id="asset-label-title">{onAddAnother ? "Barcode ready" : "Barcode label"}</h2></div>
        <button type="button" onClick={onClose} aria-label="Close barcode label"><X size={19} /></button>
      </header>
      <div className={styles.labelPreview}>
        <div><span>MAM IT asset</span><strong>{asset.assetCode}</strong><small>{assetTypeLabel(asset.assetType)} · {asset.assignedTo?.fullName ?? "Assignment required"}</small></div>
        <BarcodePreview value={asset.barcodeValue} />
      </div>
      <p className={styles.labelPrivacy}>The barcode contains the asset number only.</p>
      {actionError ? <p className={styles.inlineError} role="alert"><AlertCircle size={15} />{actionError}</p> : null}
      <footer>
        <button className={styles.secondaryAction} type="button" onClick={onAddAnother ?? onClose}>{onAddAnother ? "Add another" : "Close"}</button>
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
  </ModalBackdrop>;
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
  const assigneeRef = useRef<HTMLInputElement>(null);
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

  return <ModalBackdrop className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeWhenReady()}>
    <section className={`${styles.modal} ${styles.modalWithPicker}`} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="add-device-title" tabIndex={-1}>
      <header>
        <div><h2 id="add-device-title">Add device</h2></div>
        <button type="button" onClick={closeWhenReady} disabled={saving} aria-label="Close add device"><X size={19} /></button>
      </header>
      <form onSubmit={submit}>
        <label>
          <span>Assigned to <b aria-hidden="true">*</b></span>
          <EmployeePicker assignees={assignees} disabled={!assignees.length} inputRef={assigneeRef} />
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
        <p className={styles.formHelp}><Barcode size={15} /> An asset number and barcode are created when you save.</p>
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
  </ModalBackdrop>;
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
    <section className={`${styles.modal} ${styles.modalWithPicker}`} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="change-device-owner-title" tabIndex={-1}>
      <header>
        <div><h2 id="change-device-owner-title">Change owner</h2><p>{asset.assetCode} · {assetTypeLabel(asset.assetType)}</p></div>
        <button type="button" onClick={closeWhenReady} disabled={saving} aria-label="Close change device owner"><X size={19} /></button>
      </header>
      <form onSubmit={submit}>
        <div className={styles.currentCustodian}><UsersRound size={16} /><div><span>Currently assigned to</span><strong>{asset.assignedTo ? custodianDescription(asset) : "Assignment required"}</strong></div></div>
        <label>
          <span>Assigned to <b aria-hidden="true">*</b></span>
          <EmployeePicker assignees={assignees} defaultValue={asset.assignedTo?.personId ?? ""} disabled={!assignees.length} inputRef={assigneeRef} />
        </label>
        <p className={styles.formHelp}><Pencil size={15} /> Ownership history is kept.</p>
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
    <section className={styles.modal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="return-device-title" tabIndex={-1}>
      <header>
        <div><h2 id="return-device-title">Return device</h2><p>{asset.assetCode} · {assetTypeLabel(asset.assetType)}</p></div>
        <button type="button" onClick={closeWhenReady} disabled={saving} aria-label="Close record device return"><X size={19} /></button>
      </header>
      <form onSubmit={submit}>
        <div className={styles.currentCustodian}><UsersRound size={16} /><div><span>Returning from</span><strong>{custodianDescription(asset)}</strong></div></div>
        <label>
          <span>Hardware returned on <b aria-hidden="true">*</b></span>
          <input ref={returnedOnRef} name="returnedOn" type="date" defaultValue={melbourneToday()} max={melbourneToday()} required />
        </label>
        <p className={styles.formHelp}><CalendarCheck2 size={15} /> Device and ownership history are kept.</p>
        {error ? <p className={styles.inlineError} role="alert"><AlertCircle size={15} />{error}</p> : null}
        <footer>
          <button className={styles.secondaryAction} type="button" onClick={closeWhenReady} disabled={saving}>Cancel</button>
          <button className={styles.primaryAction} type="submit" disabled={saving}>
            {saving ? <LoaderCircle className={styles.spinner} size={16} /> : <Undo2 size={16} />}
            {saving ? "Recording…" : "Record return"}
          </button>
        </footer>
      </form>
    </section>
  </ModalBackdrop>;
}

function CustodyHistoryModal({
  asset,
  onClose,
}: {
  asset: ItAsset;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [history, setHistory] = useState<ItAssetCustodyHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useDialogFocus(true, dialogRef, closeRef, onClose);

  useEffect(() => {
    let cancelled = false;
    void listItAssetCustodyHistory(asset.id)
      .then((entries) => {
        if (cancelled) return;
        setHistory(entries);
        setError("");
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "The device history could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [asset.id]);

  return <ModalBackdrop className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className={styles.modal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="device-history-title" tabIndex={-1}>
      <header>
        <div><h2 id="device-history-title">Ownership history</h2><p>{asset.assetCode} · {assetTypeLabel(asset.assetType)}</p></div>
        <button type="button" onClick={onClose} aria-label="Close device ownership history"><X size={19} /></button>
      </header>
      <div className={styles.modalBody}>
        {loading ? <div className={styles.historyLoading}><LoaderCircle className={styles.spinner} size={16} /> Loading ownership history…</div> : null}
        {!loading && error ? <p className={styles.inlineError} role="alert"><AlertCircle size={15} />{error}</p> : null}
        {!loading && !error && !history.length ? <p className={styles.historyEmpty}>No custody history is recorded for this device yet.</p> : null}
        {!loading && !error && history.length ? <ol className={styles.historyTimeline}>
          {history.map((entry) => <li key={entry.id}>
            <ClipboardClock size={16} aria-hidden="true" />
            <div><strong>{entry.person.fullName}</strong><span>{[entry.person.positionTitle, entry.person.teamName].filter(Boolean).join(" · ")}</span><small>{formatDate(entry.assignedOn)} – {entry.returnedOn ? formatDate(entry.returnedOn) : "Currently assigned"}</small></div>
          </li>)}
        </ol> : null}
      </div>
      <footer className={styles.modalFooter}>
        <button className={styles.secondaryAction} type="button" onClick={onClose} ref={closeRef}>Close</button>
      </footer>
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
    <section className={styles.modal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="remove-device-title" tabIndex={-1}>
      <header>
        <div><h2 id="remove-device-title">Remove device?</h2><p>{asset.assetCode} · {assetTypeLabel(asset.assetType)}</p></div>
        <button type="button" onClick={closeWhenReady} disabled={saving} aria-label="Close remove device"><X size={19} /></button>
      </header>
      <div className={styles.modalBody}>
        <p>Use this only for a duplicate or mistaken record. For an employee leaving or handing hardware back, record a hardware return instead so the custody timeline stays complete.</p>
        <div className={styles.currentCustodian}><UsersRound size={16} /><div><span>Current owner</span><strong>{asset.assignedTo ? custodianDescription(asset) : "No current owner"}</strong></div></div>
        {error ? <p className={styles.inlineError} role="alert"><AlertCircle size={15} />{error}</p> : null}
      </div>
      <footer className={styles.modalFooter}>
        <button className={styles.secondaryAction} type="button" onClick={closeWhenReady} disabled={saving} ref={cancelRef}>Keep device</button>
        <button className={styles.dangerAction} type="button" onClick={() => void removeDevice()} disabled={saving}>
          {saving ? <LoaderCircle className={styles.spinner} size={16} /> : <Trash2 size={16} />}
          {saving ? "Removing…" : "Remove incorrect entry"}
        </button>
      </footer>
    </section>
  </ModalBackdrop>;
}

function AssetSheetHeader({
  label,
  sortKey,
  activeSort,
  onSort,
  filterKey,
  filterOptions = [],
  filterValue = "",
  isFilterOpen = false,
  onToggleFilter,
  onFilter,
}: {
  label: string;
  sortKey?: AssetSortKey;
  activeSort: AssetSort | null;
  onSort?: (key: AssetSortKey) => void;
  filterKey?: AssetFilterKey;
  filterOptions?: FilterOption[];
  filterValue?: string;
  isFilterOpen?: boolean;
  onToggleFilter?: (key: AssetFilterKey) => void;
  onFilter?: (key: AssetFilterKey, value: string) => void;
}) {
  const sortIsActive = sortKey !== undefined && activeSort?.key === sortKey;
  const sortDirection = sortIsActive ? activeSort.direction : undefined;
  const filterIsActive = Boolean(filterValue);

  return <div className={styles.sheetHeaderCell} role="columnheader" aria-sort={sortKey ? (sortIsActive ? sortDirection : "none") : undefined} data-asset-filter={filterKey}>
    <span>{label}</span>
    {(sortKey || filterKey) ? <span className={styles.sheetHeaderTools}>
      {sortKey && onSort ? <button
        type="button"
        className={styles.sheetHeaderButton}
        data-active={sortIsActive || undefined}
        onClick={() => onSort(sortKey)}
        aria-label={`Sort assets by ${label}${sortDirection ? `, currently ${sortDirection}` : ""}`}
        aria-pressed={sortIsActive}
        title={`Sort by ${label}`}
      ><ArrowDownUp size={13} aria-hidden="true" /></button> : null}
      {filterKey && onToggleFilter ? <button
        type="button"
        className={styles.sheetHeaderButton}
        data-asset-filter-trigger={filterKey}
        data-active={filterIsActive || undefined}
        onClick={() => onToggleFilter(filterKey)}
        aria-label={`Filter assets by ${label}`}
        aria-expanded={isFilterOpen}
        title={`Filter by ${label}`}
      ><Filter size={13} aria-hidden="true" /></button> : null}
    </span> : null}
    {filterKey && onFilter && isFilterOpen ? <div className={styles.sheetFilterMenu} role="group" aria-label={`Filter assets by ${label}`}>
      <button type="button" aria-pressed={!filterValue} onClick={() => onFilter(filterKey, "")}>All</button>
      {filterOptions.map((option) => <button key={option.value} type="button" aria-pressed={filterValue === option.value} onClick={() => onFilter(filterKey, option.value)}>{option.label}</button>)}
    </div> : null}
  </div>;
}

export function AssetRegister() {
  const [assets, setAssets] = useState<ItAsset[]>([]);
  const [assignees, setAssignees] = useState<ItAssetAssignee[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [showAddDevice, setShowAddDevice] = useState(false);
  const [labelTarget, setLabelTarget] = useState<{ asset: ItAsset; isNew: boolean } | null>(null);
  const [assignmentTarget, setAssignmentTarget] = useState<ItAsset | null>(null);
  const [returnTarget, setReturnTarget] = useState<ItAsset | null>(null);
  const [historyTarget, setHistoryTarget] = useState<ItAsset | null>(null);
  const [removalTarget, setRemovalTarget] = useState<ItAsset | null>(null);
  const [query, setQuery] = useState("");
  const [barcodeAction, setBarcodeAction] = useState<{ id: string; action: BarcodeAction } | null>(null);
  const [expandedActionsId, setExpandedActionsId] = useState<string | null>(null);
  const [assetSort, setAssetSort] = useState<AssetSort | null>(null);
  const [activeAssetFilter, setActiveAssetFilter] = useState<AssetFilterKey | null>(null);
  const [assetFilters, setAssetFilters] = useState<Record<AssetFilterKey, string>>({
    assetType: "",
    assignedTo: "",
    status: "",
  });
  const [rowError, setRowError] = useState("");
  const [notice, setNotice] = useState("");
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const actionTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const actionMenuInitialFocus = useRef<"first" | "last">("first");

  useEffect(() => {
    if (!expandedActionsId && !activeAssetFilter) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-asset-actions], [data-asset-filter]")) return;
      setExpandedActionsId(null);
      setActiveAssetFilter(null);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        const filterKey = activeAssetFilter;
        setExpandedActionsId(null);
        setActiveAssetFilter(null);
        if (filterKey) window.requestAnimationFrame(() => {
          document.querySelector<HTMLButtonElement>(`[data-asset-filter-trigger="${filterKey}"]`)?.focus();
        });
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [activeAssetFilter, expandedActionsId]);

  useEffect(() => {
    if (!expandedActionsId) return;
    const frame = window.requestAnimationFrame(() => {
      const items = actionMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
      const target = actionMenuInitialFocus.current === "last" ? items?.item((items?.length ?? 1) - 1) : items?.item(0);
      target?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expandedActionsId]);

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

  const assetFilterOptions = useMemo<Record<AssetFilterKey, FilterOption[]>>(() => ({
    assetType: Array.from(new Set(assets.map((asset) => asset.assetType)))
      .sort((first, second) => compareAssetText(assetTypeLabel(first), assetTypeLabel(second)))
      .map((value) => ({ value, label: assetTypeLabel(value) })),
    assignedTo: Array.from(new Map(assets.map((asset) => [
      asset.assignedTo?.personId ?? "unassigned",
      asset.assignedTo?.fullName ?? "Unassigned",
    ])).entries())
      .sort(([, first], [, second]) => compareAssetText(first, second))
      .map(([value, label]) => ({ value, label })),
    status: Array.from(new Set(assets.map((asset) => asset.status)))
      .sort((first, second) => compareAssetText(assetStatusLabel(first), assetStatusLabel(second)))
      .map((value) => ({ value, label: assetStatusLabel(value) })),
  }), [assets]);

  const visibleAssets = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const nextAssets = assets.filter((asset) => {
      const matchesSearch = !needle || [
        asset.assetCode,
        assetTypeLabel(asset.assetType),
        asset.manufacturer,
        asset.model,
        asset.serialNumber,
        asset.status,
        asset.assignedTo?.fullName,
        asset.assignedTo?.positionTitle,
        asset.assignedTo?.teamName,
      ].join(" ").toLocaleLowerCase().includes(needle);
      if (!matchesSearch) return false;
      if (assetFilters.assetType && asset.assetType !== assetFilters.assetType) return false;
      if (assetFilters.assignedTo && (asset.assignedTo?.personId ?? "unassigned") !== assetFilters.assignedTo) return false;
      if (assetFilters.status && asset.status !== assetFilters.status) return false;
      return true;
    });

    if (!assetSort) return nextAssets;
    const direction = assetSort.direction === "ascending" ? 1 : -1;
    return [...nextAssets].sort((first, second) => {
      let result = 0;
      switch (assetSort.key) {
        case "device":
          result = compareAssetText(assetDescription(first), assetDescription(second));
          break;
        case "assetCode":
          result = compareAssetText(first.assetCode, second.assetCode);
          break;
        case "serialNumber":
          result = compareAssetText(first.serialNumber, second.serialNumber);
          break;
        case "assignedTo":
          result = compareAssetText(first.assignedTo?.fullName, second.assignedTo?.fullName);
          break;
        case "assignedOn":
          result = compareAssetText(assetTimingValue(first), assetTimingValue(second));
          break;
        case "status":
          result = compareAssetText(assetStatusLabel(first.status), assetStatusLabel(second.status));
          break;
      }
      return result * direction;
    });
  }, [assetFilters, assets, assetSort, query]);

  const hasAssetFilters = Object.values(assetFilters).some(Boolean);

  function toggleAssetSort(key: AssetSortKey) {
    setAssetSort((current) => current?.key === key
      ? { key, direction: current.direction === "ascending" ? "descending" : "ascending" }
      : { key, direction: "ascending" });
  }

  function setAssetFilter(key: AssetFilterKey, value: string) {
    setAssetFilters((current) => ({ ...current, [key]: value }));
    setActiveAssetFilter(null);
    window.requestAnimationFrame(() => {
      const trigger = document.querySelector<HTMLButtonElement>(`[data-asset-filter-trigger="${key}"]`);
      // The phone picker owns focus while the desktop header is hidden.
      if (trigger?.getClientRects().length) trigger.focus({ preventScroll: true });
    });
  }

  function toggleAssetFilter(key: AssetFilterKey) {
    setActiveAssetFilter((current) => current === key ? null : key);
  }

  function assetCreated(asset: ItAsset) {
    setAssets((current) => [asset, ...current]);
    setShowAddDevice(false);
    setLabelTarget({ asset, isNew: true });
    setNotice(`Device assigned to ${asset.assignedTo?.fullName ?? "the selected employee"}.`);
  }

  function assetOwnerChanged(asset: ItAsset) {
    setAssets((current) => current.map((candidate) => candidate.id === asset.id ? asset : candidate));
    setAssignmentTarget(null);
    setNotice(`${asset.assetCode} is now assigned to ${asset.assignedTo?.fullName ?? "the selected employee"}.`);
  }

  function assetReturned(asset: ItAsset, returnedOn: string) {
    setAssets((current) => current.map((candidate) => candidate.id === asset.id ? asset : candidate));
    setReturnTarget(null);
    setNotice(`${asset.assetCode} was returned on ${formatDate(returnedOn)} and is ready to reassign.`);
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
      setExpandedActionsId(null);
      window.setTimeout(() => actionTriggerRefs.current.get(asset.id)?.focus(), 0);
    }
  }

  function showLabelFromRow(asset: ItAsset) {
    setExpandedActionsId(null);
    setLabelTarget({ asset, isNew: false });
  }

  function closeActionMenu(assetId: string, restoreFocus = false) {
    setExpandedActionsId(null);
    if (restoreFocus) window.setTimeout(() => actionTriggerRefs.current.get(assetId)?.focus(), 0);
  }

  function handleActionMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, assetId: string) {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
    if (event.key === "Escape") {
      event.preventDefault();
      closeActionMenu(assetId, true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  }

  return <section className={styles.workspace} aria-labelledby="asset-register-title">
    <header className={styles.header}>
      <div>
        <h2 id="asset-register-title">Devices</h2>
      </div>
      <div className={styles.headerActions}>
        <a className={styles.secondaryAction} href="/assets/export?format=csv" aria-label="Download devices as CSV" title="Download CSV"><Download size={16} aria-hidden="true" /><span>CSV</span></a>
        <a className={styles.secondaryAction} href="/assets/export?format=xlsx" aria-label="Download devices as Excel" title="Download Excel"><Download size={16} aria-hidden="true" /><span>Excel</span></a>
        <button className={styles.primaryAction} type="button" onClick={() => setShowAddDevice(true)}><PackagePlus size={17} /> Add device</button>
      </div>
    </header>

    {notice ? <div className={styles.notice} role="status"><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss message"><X size={15} /></button></div> : null}

    <div className={styles.tools}>
      <label className={styles.searchField}>
        <Search size={17} aria-hidden="true" />
        <span className={styles.visuallyHidden}>Search assets</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search devices" />
      </label>
      <div className={styles.toolSummary}>
        {hasAssetFilters ? <button className={styles.clearFilters} type="button" onClick={() => setAssetFilters({ assetType: "", assignedTo: "", status: "" })}>Clear filters</button> : null}
        <span className={styles.assetCount}>{visibleAssets.length === assets.length ? `${assets.length} ${assets.length === 1 ? "device" : "devices"}` : `${visibleAssets.length} of ${assets.length} devices`}</span>
      </div>
    </div>

    <MobileRegisterTools
      sort={assetSort}
      onSort={setAssetSort}
      sortOptions={[
        { value: "device", label: "Device" }, { value: "assetCode", label: "Asset number" },
        { value: "serialNumber", label: "Serial number" }, { value: "assignedTo", label: "Assigned to" },
        { value: "assignedOn", label: "Assigned on" }, { value: "status", label: "Status" },
      ]}
      filters={([
        { key: "assetType", label: "Device type" }, { key: "assignedTo", label: "Assigned to" },
        { key: "status", label: "Status" },
      ] as const).map(filter => ({ ...filter, value: assetFilters[filter.key], options: assetFilterOptions[filter.key] }))}
      onFilter={setAssetFilter}
    />
    {rowError ? <p className={styles.inlineError} role="alert"><AlertCircle size={15} />{rowError}</p> : null}
    {loading ? <div className={styles.loadingState}><LoaderCircle className={styles.spinner} size={21} /><span>Loading IT assets…</span></div> : null}
    {!loading && loadError ? <div className={styles.errorState} role="alert"><AlertCircle size={20} aria-hidden="true" /><div><strong>IT assets could not be loaded</strong><span>{loadError}</span></div><button className={styles.secondaryAction} type="button" onClick={() => void loadAssets()} disabled={loading}><RefreshCw size={16} aria-hidden="true" /> Retry</button></div> : null}
    {!loading && !loadError && !visibleAssets.length ? <div className={styles.emptyState}><Laptop size={28} /><strong>{assets.length ? "No matching devices" : "No devices"}</strong>{!assets.length ? <button className={styles.secondaryAction} type="button" onClick={() => setShowAddDevice(true)}><PackagePlus size={16} /> Add device</button> : null}</div> : null}
    {!loading && !loadError && visibleAssets.length ? <div className={styles.sheetViewport}>
      <div className={styles.assetSheet} role="table" aria-label="IT assets">
        <div className={`${styles.assetSheetRow} ${styles.assetSheetHeader}`} role="row">
          <AssetSheetHeader label="Device" sortKey="device" activeSort={assetSort} onSort={toggleAssetSort} filterKey="assetType" filterOptions={assetFilterOptions.assetType} filterValue={assetFilters.assetType} isFilterOpen={activeAssetFilter === "assetType"} onToggleFilter={toggleAssetFilter} onFilter={setAssetFilter} />
          <AssetSheetHeader label="Asset number" sortKey="assetCode" activeSort={assetSort} onSort={toggleAssetSort} />
          <AssetSheetHeader label="Serial number" sortKey="serialNumber" activeSort={assetSort} onSort={toggleAssetSort} />
          <AssetSheetHeader label="Assigned to" sortKey="assignedTo" activeSort={assetSort} onSort={toggleAssetSort} filterKey="assignedTo" filterOptions={assetFilterOptions.assignedTo} filterValue={assetFilters.assignedTo} isFilterOpen={activeAssetFilter === "assignedTo"} onToggleFilter={toggleAssetFilter} onFilter={setAssetFilter} />
          <AssetSheetHeader label="Assigned on" sortKey="assignedOn" activeSort={assetSort} onSort={toggleAssetSort} />
          <AssetSheetHeader label="Status" sortKey="status" activeSort={assetSort} onSort={toggleAssetSort} filterKey="status" filterOptions={assetFilterOptions.status} filterValue={assetFilters.status} isFilterOpen={activeAssetFilter === "status"} onToggleFilter={toggleAssetFilter} onFilter={setAssetFilter} />
          <div className={styles.sheetHeaderCell} role="columnheader"><span>Actions</span></div>
        </div>
        {visibleAssets.map((asset) => {
          const activeAction = barcodeAction?.id === asset.id ? barcodeAction.action : null;
          const description = assetDescription(asset);
          return <div className={styles.assetSheetRow} key={asset.id} role="row">
            <div className={`${styles.sheetCell} ${styles.assetDeviceCell}`} role="cell" data-label="Device">
              <div className={styles.assetIcon}><Laptop size={18} /></div>
              <div className={styles.assetIdentity}><strong>{assetTypeLabel(asset.assetType)}</strong>{description ? <span title={description}>{description}</span> : null}</div>
            </div>
            <div className={`${styles.sheetCell} ${styles.assetCode}`} role="cell" data-label="Asset number"><strong title={asset.assetCode}>{asset.assetCode}</strong></div>
            <div className={`${styles.sheetCell} ${styles.assetSerial}`} role="cell" data-label="Serial number"><strong title={asset.serialNumber || "No serial number"}>{asset.serialNumber || "—"}</strong></div>
            <div className={`${styles.sheetCell} ${styles.assetCustodian}`} role="cell" data-label="Assigned to" data-missing={!asset.assignedTo}><strong title={asset.assignedTo?.fullName || "Ready to assign"}>{asset.assignedTo?.fullName || "Ready to assign"}</strong></div>
            <div className={`${styles.sheetCell} ${styles.assetTiming}`} role="cell" data-label={asset.assignedTo ? "Assigned on" : "Last returned"}><strong>{assetTimingValue(asset) ? formatDate(assetTimingValue(asset)) : "—"}</strong></div>
            <div className={`${styles.sheetCell} ${styles.assetStatus}`} role="cell" data-label="Status"><span data-status={asset.status}>{assetStatusLabel(asset.status)}</span></div>
            <div className={`${styles.sheetCell} ${styles.assetActionsCell} ${styles.rowActions}`} role="cell" data-label="Actions" data-asset-actions>
              <div className={styles.moreActions}>
                <button
                  type="button"
                  className={styles.editButton}
                  onClick={() => {
                    actionMenuInitialFocus.current = "first";
                    setExpandedActionsId((current) => current === asset.id ? null : asset.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                    event.preventDefault();
                    actionMenuInitialFocus.current = event.key === "ArrowUp" ? "last" : "first";
                    setExpandedActionsId(asset.id);
                  }}
                  ref={(node) => {
                    if (node) actionTriggerRefs.current.set(asset.id, node);
                    else actionTriggerRefs.current.delete(asset.id);
                  }}
                  disabled={activeAction !== null}
                  aria-label={`Edit ${asset.assetCode}`}
                  aria-haspopup="menu"
                  aria-expanded={expandedActionsId === asset.id}
                  aria-controls={expandedActionsId === asset.id ? `asset-actions-${asset.id}` : undefined}
                >
                  <Pencil size={15} aria-hidden="true" /><span>Edit</span>
                </button>
                {expandedActionsId === asset.id ? <div className={styles.moreMenu} id={`asset-actions-${asset.id}`} ref={actionMenuRef} role="menu" aria-label={`Edit actions for ${asset.assetCode}`} aria-busy={activeAction !== null} onKeyDown={(event) => handleActionMenuKeyDown(event, asset.id)}>
                  {asset.assignedTo ? <button type="button" role="menuitem" onClick={() => { setExpandedActionsId(null); setReturnTarget(asset); }} disabled={activeAction !== null}>
                    <Undo2 size={15} /><span>Record return</span>
                  </button> : null}
                  <button type="button" role="menuitem" onClick={() => { setExpandedActionsId(null); setAssignmentTarget(asset); }} disabled={activeAction !== null}>
                    <Pencil size={15} /><span>{asset.assignedTo ? "Change owner" : "Assign owner"}</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setExpandedActionsId(null); setHistoryTarget(asset); }} disabled={activeAction !== null}>
                    <ClipboardClock size={15} /><span>View history</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => void downloadFromRow(asset)} disabled={activeAction !== null}>
                    {activeAction === "download" ? <LoaderCircle className={styles.spinner} size={15} /> : <Download size={15} />}<span>Download</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => showLabelFromRow(asset)} disabled={activeAction !== null}>
                    <Printer size={15} /><span>Label</span>
                  </button>
                  <button type="button" role="menuitem" className={styles.removeAction} onClick={() => { setExpandedActionsId(null); setRemovalTarget(asset); }} disabled={activeAction !== null}>
                    <Trash2 size={15} /><span>Remove</span>
                  </button>
                </div> : null}
              </div>
            </div>
          </div>;
        })}
      </div>
    </div> : null}

    {showAddDevice ? <AddDeviceModal assignees={assignees} onClose={() => setShowAddDevice(false)} onCreated={assetCreated} /> : null}
    {labelTarget ? <AssetLabelModal asset={labelTarget.asset} onClose={() => setLabelTarget(null)} onAddAnother={labelTarget.isNew ? () => { setLabelTarget(null); setShowAddDevice(true); } : undefined} /> : null}
    {assignmentTarget ? <ChangeDeviceOwnerModal asset={assignmentTarget} assignees={assignees} onClose={() => setAssignmentTarget(null)} onSaved={assetOwnerChanged} /> : null}
    {returnTarget ? <ReturnDeviceModal asset={returnTarget} onClose={() => setReturnTarget(null)} onReturned={assetReturned} /> : null}
    {historyTarget ? <CustodyHistoryModal asset={historyTarget} onClose={() => setHistoryTarget(null)} /> : null}
    {removalTarget ? <RemoveDeviceModal asset={removalTarget} onClose={() => setRemovalTarget(null)} onRemoved={assetRemoved} /> : null}
  </section>;
}
