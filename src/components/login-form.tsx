"use client";

import { useActionState } from "react";

import { requestSignInLink, type LoginState } from "@/app/login/actions";

const initialState: LoginState = { status: "idle", message: "" };

export function LoginForm() {
  const [state, action, pending] = useActionState(requestSignInLink, initialState);

  return (
    <form className="auth-form" action={action}>
      <label htmlFor="email">Work email</label>
      <input id="email" name="email" type="email" autoComplete="email" required placeholder="name@mobilityaccess.com.au" />
      <button type="submit" disabled={pending}>
        {pending ? "Sending link…" : "Email me a sign-in link"}
      </button>
      {state.message ? (
        <p className={`form-message${state.status === "error" ? " form-message-error" : ""}`} aria-live="polite">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
