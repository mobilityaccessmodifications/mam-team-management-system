"use client";

import Link from "next/link";
import { useActionState, useSyncExternalStore } from "react";
import { requestPasswordRecovery, resetRecoveredPassword } from "@/app/login/forgot-password/actions";
import { PASSWORD_RECOVERY_INVALID, PASSWORD_RECOVERY_TOKEN_PATTERN, type PasswordRecoveryState } from "@/lib/password-recovery";

const initialState: PasswordRecoveryState = { status: "idle", message: "" };

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(requestPasswordRecovery, initialState);
  return (
    <form className="auth-form" action={action}>
      <label htmlFor="recovery-email">Email</label>
      <input id="recovery-email" name="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254} required />
      <button type="submit" disabled={pending}>{pending ? "Sending…" : "Send reset link"}</button>
      {state.message ? <p className={`form-message${state.status === "error" ? " form-message-error" : ""}`} role="status">{state.message}</p> : null}
      <Link className="auth-link" href="/login">Back to sign in</Link>
    </form>
  );
}

function subscribeToRecoveryLink(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

function recoveryLinkToken() {
  const value = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
  return PASSWORD_RECOVERY_TOKEN_PATTERN.test(value) ? value : "";
}

export function ResetPasswordForm() {
  const [state, action, pending] = useActionState(resetRecoveredPassword, initialState);
  const token = useSyncExternalStore(subscribeToRecoveryLink, recoveryLinkToken, () => null);
  if (token === null) return null;
  if (!token) return <div className="auth-form"><p className="form-message form-message-error" role="status">{PASSWORD_RECOVERY_INVALID}</p><Link className="auth-link" href="/login/forgot-password">Request a new reset link</Link></div>;
  return (
    <form className="auth-form" action={action}>
      <input type="hidden" name="token" value={token} />
      <label htmlFor="new-password">New password</label>
      <input id="new-password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
      <label htmlFor="confirm-password">Confirm password</label>
      <input id="confirm-password" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
      <button type="submit" disabled={pending}>{pending ? "Saving…" : "Reset password"}</button>
      {state.message ? <p className="form-message form-message-error" role="status">{state.message}</p> : null}
      <Link className="auth-link" href="/login/forgot-password">Request a new reset link</Link>
    </form>
  );
}
