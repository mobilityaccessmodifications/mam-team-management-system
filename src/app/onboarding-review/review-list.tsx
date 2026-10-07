"use client";

import { type FormEvent, startTransition, useRef, useState } from "react";
import { ModalBackdrop } from "@/components/ui/modal-backdrop";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import {
  cancelOnboardingCredentialReview,
  listOnboardingCredentialReviews,
  type OnboardingCredentialReview,
} from "./actions";
import styles from "./review.module.css";

export function OnboardingCredentialReviews({ initialReviews }: { initialReviews: OnboardingCredentialReview[] }) {
  const [reviews, setReviews] = useState(initialReviews);
  const [selected, setSelected] = useState<OnboardingCredentialReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [blockedIds, setBlockedIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const blockedRef = useRef(new Set<string>());
  const dialogRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const close = () => { if (!busyRef.current) setSelected(null); };
  useDialogFocus(selected !== null, dialogRef, keepRef, close, refreshRef);

  function refresh() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setSelected(null);
    startTransition(async () => {
      try {
        const result = await listOnboardingCredentialReviews();
        if (!result.ok) { setError(result.message); return; }
        setReviews(result.reviews);
        blockedRef.current.clear();
        setBlockedIds([]);
        setError("");
        setMessage("");
      } catch {
        setError("Unable to load onboarding reviews. Refresh and try again.");
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    });
  }

  function cancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || busyRef.current || blockedRef.current.has(selected.deliveryId)) return;
    const review = selected;
    busyRef.current = true;
    blockedRef.current.add(review.deliveryId);
    setBlockedIds((ids) => [...ids, review.deliveryId]);
    setBusy(true);
    setError("");
    setMessage("");
    startTransition(async () => {
      try {
        const result = await cancelOnboardingCredentialReview({ deliveryId: review.deliveryId, updatedAt: review.updatedAt });
        if (!result.ok) { setError(result.message); return; }
        setReviews((rows) => rows.filter((row) => row.deliveryId !== review.deliveryId));
        setMessage(result.message);
      } catch {
        setError("Cancellation could not be confirmed. Refresh the list before continuing.");
      } finally {
        setSelected(null);
        busyRef.current = false;
        setBusy(false);
      }
    });
  }

  return (
    <section aria-label="Onboarding credential reviews">
      <button ref={refreshRef} className={styles.button} type="button" disabled={busy} onClick={refresh}>Refresh list</button>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {reviews.length ? <div className={styles.scroll}>
        <table className={styles.table}>
          <caption className={styles.visuallyHidden}>Onboarding credentials needing review</caption>
          <thead><tr><th scope="col">Employee</th><th scope="col">Company</th><th scope="col">Status</th><th scope="col">Review code</th><th scope="col">Claimed login</th><th scope="col">Due date</th><th scope="col">Created</th><th scope="col">Updated</th><th scope="col">Action</th></tr></thead>
          <tbody>{reviews.map((review) => <tr key={review.deliveryId}>
            <th scope="row">{review.employeeName}</th>
            <td>{review.company === "mam" ? "MAM" : "Equipsy"}</td>
            <td>Needs review</td>
            <td>{review.reviewCode ?? "—"}</td>
            <td>{review.hasClaimedLogin ? "Recorded" : "Not recorded"}</td>
            <td>{review.dueDate ?? "—"}</td>
            <td><time dateTime={review.createdAt}>{review.createdAt.slice(0, 10)}</time></td>
            <td><time dateTime={review.updatedAt}>{review.updatedAt}</time></td>
            <td><button className={styles.button} type="button" disabled={busy || blockedIds.includes(review.deliveryId)} onClick={() => setSelected(review)}>Cancel delivery</button></td>
          </tr>)}</tbody>
        </table>
      </div> : <p>No onboarding credentials need review.</p>}
      {selected ? <ModalBackdrop className={styles.backdrop} onClick={close}>
        <div className={styles.dialog} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="cancel-review-title" onClick={(event) => event.stopPropagation()}>
          <h2 id="cancel-review-title">Cancel onboarding delivery?</h2>
          <p>{selected.employeeName}</p>
          <form onSubmit={cancel}>
            <button ref={keepRef} className={styles.button} type="button" disabled={busy} onClick={close}>Keep review</button>
            <button className={styles.button} type="submit" disabled={busy}>Confirm cancellation</button>
          </form>
        </div>
      </ModalBackdrop> : null}
    </section>
  );
}
