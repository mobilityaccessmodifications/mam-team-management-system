"use client";

import {
  AlertCircle,
  CheckCircle2,
  ClipboardCopy,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createAnalyticsApiKey,
  listAnalyticsApiKeys,
  revokeAnalyticsApiKey,
  type AnalyticsApiKey,
} from "@/app/analytics-api/actions";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import styles from "@/components/analytics-api-management.module.css";

type KeyState =
  | { state: "loading" }
  | { state: "ready"; keys: AnalyticsApiKey[] }
  | { state: "error"; message: string };

function formatDate(value: string | null) {
  if (!value) return "Not used yet";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "Not available";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function copyText(value: string) {
  if (!navigator.clipboard?.writeText) return Promise.reject(new Error("Clipboard unavailable"));
  return navigator.clipboard.writeText(value);
}

export function AnalyticsApiManagement() {
  const [keyState, setKeyState] = useState<KeyState>({ state: "loading" });
  const [showCreate, setShowCreate] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<AnalyticsApiKey | null>(null);
  const [oneTimeKey, setOneTimeKey] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setKeyState({ state: "loading" });
    try {
      setKeyState({ state: "ready", keys: await listAnalyticsApiKeys() });
    } catch (reason) {
      setKeyState({
        state: "error",
        message: reason instanceof Error ? reason.message : "Analytics API access could not be loaded. Refresh and try again.",
      });
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const activeKey = useMemo(() => keyState.state === "ready"
    ? keyState.keys.find((key) => !key.revokedAt) ?? null
    : null, [keyState]);

  return <section className={styles.workspace} aria-label="Analytics API management">
    <header className={styles.header}>
      <div>
        <span className={styles.eyebrow}>System Admin</span>
        <h2>Analytics API</h2>
      </div>
      <button className={styles.primaryAction} type="button" onClick={() => { setNotice(""); setShowCreate(true); }}>
        {activeKey ? <RotateCw size={16} aria-hidden="true" /> : <KeyRound size={16} aria-hidden="true" />}
        {activeKey ? "Rotate key" : "Generate key"}
      </button>
    </header>
    <Link className={styles.copyGuide} href="/analytics-api-docs">API documentation</Link>

    {notice ? <p className={styles.notice} role="status"><CheckCircle2 size={16} aria-hidden="true" />{notice}</p> : null}
    {keyState.state === "loading" ? <div className={styles.state}><LoaderCircle className={styles.spinner} size={22} /><span>Loading API access…</span></div> : null}
    {keyState.state === "error" ? <div className={`${styles.state} ${styles.errorState}`} role="alert"><AlertCircle size={19} aria-hidden="true" /><div><strong>API access could not be loaded</strong><span>{keyState.message}</span></div><button className={styles.secondaryAction} type="button" onClick={() => void load()}><RefreshCw size={15} aria-hidden="true" />Retry</button></div> : null}
    {keyState.state === "ready" ? <div className={styles.keyPanel}>
      <div className={styles.keyStatus}>
        <span className={`${styles.status} ${activeKey ? styles.statusActive : ""}`}>{activeKey ? "Active key" : "No managed key"}</span>
        <div>
          <strong>{activeKey?.label ?? "No API key"}</strong>
          <small>{activeKey ? `${activeKey.keyPrefix}… · Last used ${formatDate(activeKey.lastUsedAt)}` : "The existing deployment key remains available until a managed key is generated."}</small>
        </div>
      </div>
      <div className={styles.keyActions}>
        <button className={styles.secondaryAction} type="button" onClick={() => void load()}><RefreshCw size={15} aria-hidden="true" />Refresh</button>
        {activeKey ? <button className={styles.dangerAction} type="button" onClick={() => { setNotice(""); setRevokeTarget(activeKey); }}><Trash2 size={15} aria-hidden="true" />Revoke</button> : null}
      </div>
    </div> : null}

    <details className={styles.guide}>
      <summary>Connection details</summary>
      <div className={styles.guideGrid}>
        <div><span>Endpoint</span><code>/api/analytics/v1</code></div>
        <div><span>Header</span><code>Authorization: Bearer &lt;API_KEY&gt;</code></div>
      </div>
      <p className={styles.guideNote}><ShieldCheck size={16} aria-hidden="true" />Choose a dataset, then add <code>from</code>, <code>to</code>, <code>limit</code> and <code>offset</code> as needed. Available datasets: overview, employees, leave requests/events, check-ins/events, asset custody, subscriptions/events.</p>
      <button className={styles.copyGuide} type="button" onClick={async () => {
        const exampleEndpoint = `${window.location.origin}/api/analytics/v1?dataset=overview`;
        try {
          await copyText(`curl --fail --silent -H "Authorization: Bearer $MAM_ANALYTICS_API_KEY" "${exampleEndpoint}"`);
          setNotice("Example request copied.");
        } catch {
          setNotice("Copy is unavailable in this browser. Use the example in the API guide.");
        }
      }}><ClipboardCopy size={15} aria-hidden="true" />Copy example</button>
    </details>

    {showCreate ? <CreateKeyDialog
      rotating={Boolean(activeKey)}
      onClose={() => setShowCreate(false)}
      onCreated={(key) => {
        setShowCreate(false);
        setOneTimeKey(key);
        setNotice("");
        void load();
      }}
    /> : null}
    {revokeTarget ? <RevokeKeyDialog
      target={revokeTarget}
      onClose={() => setRevokeTarget(null)}
      onRevoked={() => {
        setRevokeTarget(null);
        setNotice("Analytics API access was revoked.");
        void load();
      }}
    /> : null}
    {oneTimeKey ? <OneTimeKeyDialog keyValue={oneTimeKey} onClose={() => { setOneTimeKey(""); setNotice("Store the key in the dashboard platform before connecting it."); }} /> : null}
  </section>;
}

function CreateKeyDialog({ rotating, onClose, onCreated }: { rotating: boolean; onClose: () => void; onCreated: (key: string) => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useDialogFocus(true, dialogRef, labelRef, () => { if (!saving) onClose(); });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const label = new FormData(event.currentTarget).get("label");
    setSaving(true);
    setError("");
    const result = await createAnalyticsApiKey(typeof label === "string" ? label : "");
    setSaving(false);
    if (!result.ok || !result.key) {
      setError(result.ok ? "Analytics API access could not be created. Refresh and try again." : result.message);
      return;
    }
    onCreated(result.key);
  }

  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
    <section className={styles.modal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="create-analytics-key-title" tabIndex={-1}>
      <header><div><h2 id="create-analytics-key-title">{rotating ? "Rotate Analytics API key" : "Generate Analytics API key"}</h2></div><button className={styles.iconButton} type="button" onClick={onClose} disabled={saving} aria-label="Close"><X size={18} /></button></header>
      <form onSubmit={submit}>
        <label><span>Connection label</span><input ref={labelRef} name="label" maxLength={80} defaultValue="Dashboard connection" required /></label>
        <p className={styles.warning}><ShieldAlert size={17} aria-hidden="true" />{rotating ? "The current key stops working immediately after rotation." : "The key is shown once. Save it in the dashboard platform before closing."}</p>
        {error ? <p className={styles.inlineError} role="alert"><AlertCircle size={16} aria-hidden="true" />{error}</p> : null}
        <footer><button className={styles.secondaryAction} type="button" onClick={onClose} disabled={saving}>Cancel</button><button className={styles.primaryAction} type="submit" disabled={saving}>{saving ? rotating ? "Rotating…" : "Generating…" : rotating ? "Rotate key" : "Generate key"}</button></footer>
      </form>
    </section>
  </div>;
}

function RevokeKeyDialog({ target, onClose, onRevoked }: { target: AnalyticsApiKey; onClose: () => void; onRevoked: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useDialogFocus(true, dialogRef, cancelRef, () => { if (!saving) onClose(); });

  async function revoke() {
    if (saving) return;
    setSaving(true);
    setError("");
    const result = await revokeAnalyticsApiKey(target.id);
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onRevoked();
  }

  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
    <section className={styles.modal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="revoke-analytics-key-title" tabIndex={-1}>
      <header><div><h2 id="revoke-analytics-key-title">Revoke API key?</h2></div><button className={styles.iconButton} type="button" onClick={onClose} disabled={saving} aria-label="Close"><X size={18} /></button></header>
      <div className={styles.dialogBody}><p><strong>{target.label}</strong> will lose dashboard access immediately. Existing reports may stop refreshing.</p>{error ? <p className={styles.inlineError} role="alert"><AlertCircle size={16} aria-hidden="true" />{error}</p> : null}<footer><button ref={cancelRef} className={styles.secondaryAction} type="button" onClick={onClose} disabled={saving}>Cancel</button><button className={styles.dangerAction} type="button" onClick={() => void revoke()} disabled={saving}>{saving ? "Revoking…" : "Revoke access"}</button></footer></div>
    </section>
  </div>;
}

function OneTimeKeyDialog({ keyValue, onClose }: { keyValue: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  useDialogFocus(true, dialogRef, copyRef, onClose);

  async function copyKey() {
    try {
      await copyText(keyValue);
      setCopied(true);
      setError("");
    } catch {
      setError("Copy is unavailable in this browser. Select and copy the key before closing.");
    }
  }

  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className={styles.modal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="one-time-analytics-key-title" tabIndex={-1}>
      <header><div><h2 id="one-time-analytics-key-title">Analytics API key</h2></div><button className={styles.iconButton} type="button" onClick={onClose} aria-label="Close"><X size={18} /></button></header>
      <div className={styles.dialogBody}>
        <p className={styles.warning}><ShieldAlert size={17} aria-hidden="true" />This is the only time this key is shown. Save it in the dashboard platform’s encrypted connection settings.</p>
        <label className={styles.keyField}><span>API key</span><input value={keyValue} readOnly aria-label="Generated Analytics API key" onFocus={(event) => event.currentTarget.select()} /></label>
        {error ? <p className={styles.inlineError} role="alert"><AlertCircle size={16} aria-hidden="true" />{error}</p> : null}
        <footer><button ref={copyRef} className={styles.secondaryAction} type="button" onClick={() => void copyKey()}><ClipboardCopy size={15} aria-hidden="true" />{copied ? "Copied" : "Copy key"}</button><button className={styles.primaryAction} type="button" onClick={onClose}>Done</button></footer>
      </div>
    </section>
  </div>;
}
