"use client";

import { useActionState, useState } from "react";

import { signIn, type LoginState } from "@/app/login/actions";

const initialState: LoginState = { status: "idle", message: "" };

export function LoginForm({ initialMessage = "" }: { initialMessage?: string }) {
  const [state, action, pending] = useActionState(signIn, initialState);
  const [messageDismissed, setMessageDismissed] = useState(false);
  const message = state.message || initialMessage;
  const visibleMessage = !pending && !messageDismissed ? message : "";

  return (
    <form
      className="auth-form"
      action={action}
      onSubmit={() => setMessageDismissed(false)}
    >
      <label htmlFor="username">Username</label>
      <input
        id="username"
        name="username"
        type="text"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={64}
        required
        autoFocus
        aria-describedby={visibleMessage ? "login-message" : undefined}
        onChange={() => setMessageDismissed(true)}
      />
      <label htmlFor="password">Password</label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        minLength={8}
        maxLength={128}
        required
        aria-describedby={visibleMessage ? "login-message" : undefined}
        onChange={() => setMessageDismissed(true)}
      />
      <button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      {visibleMessage ? (
        <p
          id="login-message"
          className="form-message form-message-error"
          aria-live="polite"
        >
          {visibleMessage}
        </p>
      ) : null}
    </form>
  );
}
