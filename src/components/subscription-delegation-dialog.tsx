"use client";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { listSubscriptionManagementDelegates, replaceSubscriptionManagementDelegates } from "@/app/subscriptions/delegation-actions";
import { listSubscriptionCredentialAccessGrants, listSubscriptionCredentialGrantCandidates, replaceSubscriptionCredentialAccessGrants } from "@/app/subscription-credentials/actions";
import type { SubscriptionCredentialAccessGrant } from "@/lib/subscription-credential-types";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import { ModalBackdrop } from "@/components/ui/modal-backdrop";
import styles from "@/components/subscription-credential-vault.module.css";
export function SubscriptionDelegationDialog({ onClose, onSaved }: { onClose: () => void; onSaved?: () => void }) {
  const [people, setPeople] = useState<SubscriptionCredentialAccessGrant[]>([]);
  const [management, setManagement] = useState<string[]>([]);
  const [vault, setVault] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = () => { if (!saving) onClose(); };
  useDialogFocus(true, dialogRef, closeRef, close);
  useEffect(() => {
    let current = true;
    void Promise.all([listSubscriptionCredentialGrantCandidates(), listSubscriptionManagementDelegates(), listSubscriptionCredentialAccessGrants()]).then(([candidates, managers, credentials]) => {
      if (!current) return;
      if (!managers.ok) throw new Error();
      setPeople(candidates);
      setManagement(managers.delegates.map(person => person.personId));
      setVault(credentials.map(person => person.personId));
      setLoadFailed(false);
      setError("");
    }).catch(() => {
      if (current) { setLoadFailed(true); setError("Subscription delegation could not be loaded. Retry before saving."); }
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [reload]);
  const toggle = (ids: string[], personId: string) => ids.includes(personId) ? ids.filter(id => id !== personId) : [...ids, personId];
  async function save() {
    if (saving || loading || loadFailed) return;
    setSaving(true);
    setError("");
    let managementCommitted = false;
    let complete = false;
    try {
      const register = await replaceSubscriptionManagementDelegates(management);
      managementCommitted = register.ok || register.committed === true;
      if (!register.ok) {
        setError(register.message);
        if (register.committed) setLoadFailed(true);
        return;
      }
      const credentials = await replaceSubscriptionCredentialAccessGrants(vault);
      if (!credentials.ok) {
        setLoadFailed(true);
        setError("Register management was saved. Credential access was not confirmed. Reload delegation before saving again.");
        return;
      }
      complete = true;
    } catch {
      setLoadFailed(true);
      setError("Delegation changes could not be confirmed. Reload before saving again.");
    } finally {
      try {
        if (managementCommitted) onSaved?.();
        if (complete) onClose();
      } catch {
        setLoadFailed(true);
        setError("Delegation changes could not be confirmed. Reload before saving again.");
      } finally { setSaving(false); }
    }
  }
  return <ModalBackdrop className={styles.modalBackdrop} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className={styles.modal} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="subscription-delegation-title" tabIndex={-1}>
      <header><div><h2 id="subscription-delegation-title">Subscription delegation</h2><p>Admin and Super Admin have role-derived operational access. Active Managers and Employees may receive either independent grant below; only Super Admin controls delegation.</p></div><button ref={closeRef} type="button" className={styles.iconButton} onClick={close} disabled={saving} aria-label="Close subscription delegation"><X size={19} /></button></header>
      {loading ? <p role="status">Loading delegates…</p> : <div className={styles.grantBody}>
        <div className={styles.grantList}>{people.map(person => <div className={styles.grantOption} key={person.personId}><span><strong>{person.fullName}</strong><small>{person.positionTitle}</small></span><label>Register management<input type="checkbox" role="switch" aria-label={`Register management for ${person.fullName}`} checked={management.includes(person.personId)} disabled={saving || loadFailed} onChange={() => setManagement(ids => toggle(ids, person.personId))} /></label><label>Credential vault<input type="checkbox" role="switch" aria-label={`Credential vault for ${person.fullName}`} checked={vault.includes(person.personId)} disabled={saving || loadFailed} onChange={() => setVault(ids => toggle(ids, person.personId))} /></label></div>)}</div>
        {error ? <p role="alert" className={styles.inlineError}>{error}</p> : null}
        <footer><button type="button" className={styles.secondaryAction} onClick={close} disabled={saving}>Cancel</button>{loadFailed ? <button type="button" className={styles.secondaryAction} onClick={() => { setLoading(true); setReload(value => value + 1); }}>Reload delegation</button> : null}<button type="button" className={styles.primaryAction} disabled={saving || loadFailed} onClick={() => void save()}>{saving ? "Saving…" : "Save delegation"}</button></footer>
      </div>}
    </section>
  </ModalBackdrop>;
}
