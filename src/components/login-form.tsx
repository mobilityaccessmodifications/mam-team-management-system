"use client";

import { useActionState } from "react";

import {
  requestSignInCode,
  type LoginState,
  verifySignInCode,
} from "@/app/login/actions";

const initialState: LoginState = { status: "idle", message: "" };

export function LoginForm() {
  const [requestState, requestAction, requestPending] = useActionState(
    requestSignInCode,
    initialState,
  );
  const [verifyState, verifyAction, verifyPending] = useActionState(
    verifySignInCode,
    initialState,
  );

  if (requestState.status === "success" && requestState.email) {
    return (
      <form className="auth-form" action={verifyAction}>
        <input type="hidden" name="email" value={requestState.email} />
        <label htmlFor="token">Sign-in code</label>
        <input
          id="token"
          name="token"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          minLength={6}
          maxLength={6}
          required
          autoFocus
          aria-describedby="login-code-message"
          aria-invalid={verifyState.status === "error"}
          placeholder="000000"
        />
        <button type="submit" disabled={verifyPending}>
          {verifyPending ? "Checking code…" : "Sign in"}
        </button>
        <p
          id="login-code-message"
          className={`form-message${verifyState.status === "error" ? " form-message-error" : ""}`}
          aria-live="polite"
        >
          {verifyState.message || requestState.message}
        </p>
        <a href="/login">Use a different email</a>
      </form>
    );
  }

  return (
    <form className="auth-form" action={requestAction}>
      <label htmlFor="email">Work email</label>
      <input id="email" name="email" type="email" autoComplete="email" required placeholder="name@mobilityaccess.com.au" />
      <button type="submit" disabled={requestPending}>
        {requestPending ? "Sending code…" : "Send sign-in code"}
      </button>
      {requestState.message ? (
        <p className={`form-message${requestState.status === "error" ? " form-message-error" : ""}`} aria-live="polite">
          {requestState.message}
        </p>
      ) : null}
    </form>
  );
}
