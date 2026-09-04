"use client";

import {
  AlertCircle,
  CheckCircle2,
  ClipboardCopy,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Save,
  ShieldCheck,
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
  listSubscriptionCredentialAccessGrants,
  listSubscriptionCredentialGrantCandidates,
  listSubscriptionCredentialCatalogue,
  readSubscriptionCredential,
  removeSubscriptionCredential,
  replaceSubscriptionCredentialAccessGrants,
  saveSubscriptionCredential,
} from "@/app/subscription-credentials/actions";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import styles from "@/components/subscription-credential-vault.module.css";
import type {
  SubscriptionCredentialAccessGrant,
  SubscriptionCredentialCatalogueItem,
  SubscriptionCredentialDraft,
} from "@/lib/subscription-credential-types";

const EMPTY_DRAFT: SubscriptionCredentialDraft = {
  loginUrl: "",
  username: "",
  password: "",
  recoveryCodes: "",
  notes: "",
};

type CatalogueState =
  | { state: "loading" }
  | { state: "ready"; items: SubscriptionCredentialCatalogueItem[] }
  | { state: "error"; message: string };

function statusLabel(status: SubscriptionCredentialCatalogueItem["status"]) {
  return status[0].toUpperCase() + status.slice(1);
}

/**
 * Minimal credential-only subscription surface for explicit delegates. It never
 * queries or renders the System-Admin-only cost, owner or membership register.
 */
export function SubscriptionCredentialVault({
  canManageCredentialGrants = false,
}: {
  canManageCredentialGrants?: boolean;
}) {
  const [catalogueState, setCatalogueState] = useState<CatalogueState>({ state: "loading" });
  const [credentialTarget, setCredentialTarget] = useState<SubscriptionCredentialCatalogueItem | null>(null);
  const [showGrantAccess, setShowGrantAccess] = useState(false);

  const load = useCallback(async () => {
    setCatalogueState({ state: "loading" });
    try {
      setCatalogueState({ state: "ready", items: await listSubscriptionCredentialCatalogue() });
    } catch (error) {
      setCatalogueState({
        state: "error",
        message: error instanceof Error ? error.message : "Credentials could not be loaded. Refresh and try again.",
      });
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function updateCredentialState(subscriptionId: string, credentialsSaved: boolean) {
    setCatalogueState((current) => current.state !== "ready" ? current : {
      state: "ready",
      items: current.items.map((item) => item.subscriptionId === subscriptionId ? { ...item, credentialsSaved } : item),
    });
  }

  return <section className={styles.workspace} aria-label="Subscription credentials">
    <header className={styles.header}>
      <div>
        <h2>Credentials</h2>
      </div>
      {canManageCredentialGrants ? <button className={styles.secondaryAction} type="button" onClick={() => setShowGrantAccess(true)} aria-label="Manage credential access" title="Credential access"><UsersRound size={16} aria-hidden="true" /></button> : null}
    </header>

    {catalogueState.state === "loading" ? <div className={styles.state}><LoaderCircle className={styles.spinner} size={22} /><span>Loading credential services…</span></div> : null}
    {catalogueState.state === "error" ? <div className={`${styles.state} ${styles.errorState}`} role="alert"><AlertCircle size={19} /><div><strong>Credentials could not be loaded</strong><span>{catalogueState.message}</span></div><button className={styles.secondaryAction} type="button" onClick={() => void load()}><RefreshCw size={15} /> Retry</button></div> : null}
    {catalogueState.state === "ready" && !catalogueState.items.length ? <div className={styles.state}><KeyRound size={22} /><strong>No subscription services are available</strong></div> : null}
    {catalogueState.state === "ready" && catalogueState.items.length ? <div className={styles.catalogue} role="table" aria-label="Subscription credential services">
      <div className={`${styles.catalogueRow} ${styles.catalogueHeader}`} role="row"><span role="columnheader">Service</span><span role="columnheader">Status</span><span role="columnheader">Credentials</span><span role="columnheader">Action</span></div>
      {catalogueState.items.map((item) => <div className={styles.catalogueRow} key={item.subscriptionId} role="row">
        <div role="cell" data-label="Service"><strong>{item.serviceName}</strong>{item.planName ? <small>{item.planName}</small> : null}</div>
        <div role="cell" data-label="Status"><span className={styles.status} data-status={item.status}>{statusLabel(item.status)}</span></div>
        <div role="cell" data-label="Credentials"><span className={styles.credentialState} data-saved={item.credentialsSaved}>{item.credentialsSaved ? "Saved" : "Not saved"}</span></div>
        <div role="cell" data-label="Action"><button className={styles.primaryAction} type="button" onClick={() => setCredentialTarget(item)}><KeyRound size={15} /> Credentials</button></div>
      </div>)}
    </div> : null}

    {credentialTarget ? <SubscriptionCredentialEditor
      subscriptionId={credentialTarget.subscriptionId}
      serviceName={credentialTarget.serviceName}
      planName={credentialTarget.planName}
      credentialsSaved={credentialTarget.credentialsSaved}
      onClose={() => setCredentialTarget(null)}
      onSaved={() => updateCredentialState(credentialTarget.subscriptionId, true)}
      onRemoved={() => updateCredentialState(credentialTarget.subscriptionId, false)}
    /> : null}
    {showGrantAccess ? <SubscriptionCredentialAccessDialog onClose={() => setShowGrantAccess(false)} /> : null}
  </section>;
}

/** Explicit credential drawer; it is mounted only after an authorised click. */
export function SubscriptionCredentialEditor({
  subscriptionId,
  serviceName,
  planName = "",
  credentialsSaved,
  onClose,
  onSaved,
  onRemoved,
}: {
  subscriptionId: string;
  serviceName: string;
  planName?: string;
  /** Safe catalogue metadata only; it never includes a credential field. */
  credentialsSaved: boolean;
  onClose: () => void;
  onSaved?: () => void;
  onRemoved?: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<SubscriptionCredentialDraft>(EMPTY_DRAFT);
  const [credentialVersion, setCredentialVersion] = useState(0);
  const [hasStoredCredential, setHasStoredCredential] = useState(credentialsSaved);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sensitiveVisible, setSensitiveVisible] = useState(!credentialsSaved);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const closeWhenReady = useCallback(() => { if (!saving) onClose(); }, [onClose, saving]);
  useDialogFocus(true, dialogRef, initialFocusRef, closeWhenReady);

  useEffect(() => {
    if (!loading && sensitiveVisible) initialFocusRef.current?.focus();
  }, [loading, sensitiveVisible]);

  // This lock clears plaintext from React state rather than merely masking the
  // inputs. Saved values require another explicitly authorised reveal; a new
  // unsaved record stays editable but its typed values are cleared as well.
  useEffect(() => {
    if (!sensitiveVisible) return;
    const timer = window.setTimeout(() => {
      setDraft(EMPTY_DRAFT);
      setCredentialVersion(0);
      if (hasStoredCredential) {
        setSensitiveVisible(false);
        setPasswordVisible(false);
        setNotice("Sensitive values are hidden again.");
      } else {
        setNotice("Unsaved values were cleared for privacy. Enter them again before saving.");
      }
    }, 60_000);
    return () => window.clearTimeout(timer);
  }, [hasStoredCredential, sensitiveVisible]);

  function changeField(field: keyof SubscriptionCredentialDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function reveal() {
    if (loading || saving) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const credential = await readSubscriptionCredential(subscriptionId);
      if (credential) {
        setDraft({
          loginUrl: credential.loginUrl,
          username: credential.username,
          password: credential.password,
          recoveryCodes: credential.recoveryCodes,
          notes: credential.notes,
        });
        setCredentialVersion(credential.credentialVersion);
        setHasStoredCredential(true);
      } else {
        // The record was removed by another authorised manager. Start a new
        // encrypted record instead of presenting stale local state.
        setDraft(EMPTY_DRAFT);
        setCredentialVersion(0);
        setHasStoredCredential(false);
      }
      setSensitiveVisible(true);
      setPasswordVisible(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The credential could not be opened. Refresh and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || loading || !sensitiveVisible) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await saveSubscriptionCredential({ subscriptionId, credentialVersion, credential: draft });
      // Do not keep the just-saved plaintext in browser state. A new explicit
      // reveal reads the versioned encrypted record if further edits are needed.
      setDraft(EMPTY_DRAFT);
      setCredentialVersion(0);
      setHasStoredCredential(true);
      setSensitiveVisible(false);
      setPasswordVisible(false);
      setNotice("Credentials saved.");
      onSaved?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The credential could not be saved. Refresh and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (saving || loading || !hasStoredCredential || !sensitiveVisible || credentialVersion < 1) return;
    if (!window.confirm(`Remove the saved credentials for ${serviceName}? This cannot be undone.`)) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await removeSubscriptionCredential({ subscriptionId, credentialVersion });
      setDraft(EMPTY_DRAFT);
      setCredentialVersion(0);
      setHasStoredCredential(false);
      setSensitiveVisible(true);
      setPasswordVisible(false);
      setNotice("Credentials removed.");
      onRemoved?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The credential could not be removed. Refresh and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function copy(value: string, label: string) {
    if (!sensitiveVisible || !value || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copied. Clear your clipboard when you finish.`);
    } catch {
      setError("The value could not be copied. Select it manually instead.");
    }
  }

  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeWhenReady()}>
    <section className={styles.modal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="credential-dialog-title" tabIndex={-1}>
      <header>
        <div><h2 id="credential-dialog-title">{serviceName}</h2>{planName ? <p>{planName}</p> : null}</div>
        <button className={styles.iconButton} type="button" onClick={closeWhenReady} disabled={saving} aria-label="Close credentials"><X size={19} /></button>
      </header>
      {loading ? <div className={styles.dialogState}><LoaderCircle className={styles.spinner} size={22} /> Opening encrypted credentials…</div> : hasStoredCredential && !sensitiveVisible ? <div className={styles.lockedCredentialState}>
        <LockKeyhole size={22} />
        <div><strong>Credentials locked</strong></div>
        {error ? <p className={styles.inlineError} role="alert"><AlertCircle size={15} />{error}</p> : null}
        {notice ? <p className={styles.notice} role="status"><CheckCircle2 size={15} />{notice}</p> : null}
        <footer><button className={styles.secondaryAction} type="button" onClick={closeWhenReady}>Close</button><button className={styles.primaryAction} type="button" onClick={() => void reveal()}><Eye size={16} /> Reveal credentials</button></footer>
      </div> : <form onSubmit={save}>
        <p className={styles.safetyNote}><LockKeyhole size={16} /> Values are cleared from this page after one minute. Close this window when you finish.</p>
        <label><span>Login URL <small>Optional</small></span><input ref={initialFocusRef} type="url" inputMode="url" autoComplete="off" data-1p-ignore="true" data-lpignore="true" value={draft.loginUrl} onChange={(event) => changeField("loginUrl", event.target.value)} placeholder="https://…" /></label>
        <label><span>Account / username <small>Optional</small></span><input autoComplete="off" data-1p-ignore="true" data-lpignore="true" value={draft.username} onChange={(event) => changeField("username", event.target.value)} placeholder="name@example.com" /></label>
        <label><span>Password <small>Optional</small></span><div className={styles.secretField}><input type={passwordVisible ? "text" : "password"} autoComplete="new-password" data-1p-ignore="true" data-lpignore="true" value={draft.password} onChange={(event) => changeField("password", event.target.value)} placeholder="Enter password" />{draft.password ? <><button type="button" onClick={() => setPasswordVisible((visible) => !visible)} aria-label={passwordVisible ? "Hide password" : "Show password"}>{passwordVisible ? <EyeOff size={16} /> : <Eye size={16} />}</button><button type="button" onClick={() => void copy(draft.password, "Password")} aria-label="Copy password"><ClipboardCopy size={16} /></button></> : null}</div></label>
        <label><span>Recovery codes <small>Optional</small></span><textarea autoComplete="off" data-1p-ignore="true" data-lpignore="true" value={draft.recoveryCodes} onChange={(event) => changeField("recoveryCodes", event.target.value)} placeholder="One code per line" rows={4} />{draft.recoveryCodes ? <button className={styles.copyTextButton} type="button" onClick={() => void copy(draft.recoveryCodes, "Recovery codes")}><ClipboardCopy size={15} /> Copy recovery codes</button> : null}</label>
        <label><span>Notes <small>Optional</small></span><textarea value={draft.notes} onChange={(event) => changeField("notes", event.target.value)} placeholder="Only operational notes needed to use this account" rows={3} /></label>
        {error ? <p className={styles.inlineError} role="alert"><AlertCircle size={15} />{error}</p> : null}
        {notice ? <p className={styles.notice} role="status"><CheckCircle2 size={15} />{notice}</p> : null}
        <footer><button className={styles.secondaryAction} type="button" onClick={closeWhenReady} disabled={saving}>Close</button>{hasStoredCredential ? <button className={styles.dangerAction} type="button" onClick={() => void remove()} disabled={saving}><Trash2 size={16} /> Remove</button> : null}<button className={styles.primaryAction} type="submit" disabled={saving}>{saving ? <LoaderCircle className={styles.spinner} size={16} /> : <Save size={16} />}{saving ? "Saving…" : "Save credentials"}</button></footer>
      </form>}
    </section>
  </div>;
}

/** System Admin-only editor for the explicit credential delegate list. */
export function SubscriptionCredentialAccessDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const [people, setPeople] = useState<SubscriptionCredentialAccessGrant[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [hasLoadError, setHasLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const closeWhenReady = useCallback(() => { if (!saving) onClose(); }, [onClose, saving]);
  useDialogFocus(true, dialogRef, initialFocusRef, closeWhenReady);

  useEffect(() => {
    let isCurrent = true;
    async function load() {
      setLoading(true);
      setHasLoadError(false);
      setError("");
      try {
        const [availablePeople, grants] = await Promise.all([
          listSubscriptionCredentialGrantCandidates(),
          listSubscriptionCredentialAccessGrants(),
        ]);
        if (!isCurrent) return;
        setPeople(availablePeople);
        setSelectedIds(grants.map((grant: SubscriptionCredentialAccessGrant) => grant.personId));
      } catch (reason) {
        if (isCurrent) {
          setHasLoadError(true);
          setError(reason instanceof Error ? reason.message : "Credential access could not be loaded. Refresh and try again.");
        }
      } finally {
        if (isCurrent) setLoading(false);
      }
    }
    void load();
    return () => { isCurrent = false; };
  }, []);

  const selected = new Set(selectedIds);
  const filteredPeople = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return people.filter((person) => !term || [person.fullName, person.positionTitle].join(" ").toLocaleLowerCase().includes(term));
  }, [people, query]);

  function toggle(personId: string) {
    setSelectedIds((current) => current.includes(personId) ? current.filter((id) => id !== personId) : [...current, personId]);
  }

  async function save() {
    if (saving || loading || hasLoadError) return;
    setSaving(true);
    setError("");
    try {
      const result = await replaceSubscriptionCredentialAccessGrants(selectedIds);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Credential access could not be saved. Refresh and try again.");
    } finally {
      setSaving(false);
    }
  }

  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeWhenReady()}>
    <section className={styles.modal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="credential-access-title" tabIndex={-1}>
      <header><div><h2 id="credential-access-title">Credential access</h2><p>Super Admin always has access. Selected people can view and update credentials.</p></div><button className={styles.iconButton} type="button" onClick={closeWhenReady} disabled={saving} aria-label="Close credential access"><X size={19} /></button></header>
      {loading ? <div className={styles.dialogState}><LoaderCircle className={styles.spinner} size={22} /> Loading active employees…</div> : <div className={styles.grantBody}>
        <label className={styles.searchField}><span className={styles.visuallyHidden}>Search active employees</span><input ref={initialFocusRef} value={query} onChange={(event) => setQuery(event.target.value)} type="search" placeholder="Search employee" /></label>
        <p className={styles.selectionCount}>{selectedIds.length} {selectedIds.length === 1 ? "delegate selected" : "delegates selected"}</p>
        <div className={styles.grantList}>{filteredPeople.length ? filteredPeople.map((person) => <label className={styles.grantOption} key={person.personId}><input checked={selected.has(person.personId)} onChange={() => toggle(person.personId)} type="checkbox" /><span><strong>{person.fullName}</strong><small>{person.positionTitle}</small></span></label>) : <p className={styles.emptyGrantList}>No active portal employees match that search.</p>}</div>
        {error ? <p className={styles.inlineError} role="alert"><AlertCircle size={15} />{error}</p> : null}
        <footer><button className={styles.secondaryAction} type="button" onClick={closeWhenReady} disabled={saving}>Cancel</button><button className={styles.primaryAction} type="button" onClick={() => void save()} disabled={saving || hasLoadError}>{saving ? <LoaderCircle className={styles.spinner} size={16} /> : <ShieldCheck size={16} />}{saving ? "Saving…" : "Save access"}</button></footer>
      </div>}
    </section>
  </div>;
}
