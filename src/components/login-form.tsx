"use client";

import { useActionState } from "react";

import { signIn, type LoginState } from "@/app/login/actions";

const initialState: LoginState = { status: "idle", message: "" };

export function LoginForm() {
  const [state, action, pending] = useActionState(signIn, initialState);

  return (
    <form className="auth-form" action={action}>
      <label htmlFor="username">Username</label>
      <input
        id="username"
        name="username"
        type="text"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={32}
        required
        defaultValue="admin"
        aria-describedby={state.message ? "login-message" : undefined}
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
        autoFocus
        aria-describedby={state.message ? "login-message" : undefined}
      />
      <button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      {state.message ? (
        <p
          id="login-message"
          className="form-message form-message-error"
          aria-live="polite"
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
