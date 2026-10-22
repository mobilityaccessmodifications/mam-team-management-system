"use client";

import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { useActionState, useState } from "react";

import { signIn, type LoginState } from "@/app/login/actions";

const initialState: LoginState = { status: "idle", message: "" };

export function LoginForm({ initialMessage = "", returnTo = "", passwordReset = false, initialLogin = "" }: { initialMessage?: string; returnTo?: string; passwordReset?: boolean; initialLogin?: string }) {
  const [state, action, pending] = useActionState(signIn, initialState);
  const [messageDismissed, setMessageDismissed] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const message = state.message || initialMessage;
  const visibleMessage = !pending && !messageDismissed ? message : "";

  return (
    <form
      className="auth-form"
      action={action}
      onSubmit={() => setMessageDismissed(false)}
    >
      <input type="hidden" name="next" value={returnTo} />
      <label htmlFor="username">Email or username</label>
      <input
        id="username"
        name="username"
        defaultValue={initialLogin}
        type="text"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={254}
        required
        aria-describedby={visibleMessage ? "login-message" : undefined}
        onChange={() => setMessageDismissed(true)}
      />
      <label htmlFor="password">Password</label>
      <span className="auth-password-field">
        <input
          id="password"
          name="password"
          type={showPassword ? "text" : "password"}
          autoComplete="current-password"
          minLength={8}
          maxLength={128}
          required
          aria-describedby={visibleMessage ? "login-message" : undefined}
          onChange={() => setMessageDismissed(true)}
        />
        <button
          className="auth-password-toggle"
          type="button"
          aria-label={showPassword ? "Hide password" : "Show password"}
          title={showPassword ? "Hide password" : "Show password"}
          onClick={() => setShowPassword((visible) => !visible)}
        >
          {showPassword ? <EyeOff aria-hidden="true" size={18} /> : <Eye aria-hidden="true" size={18} />}
        </button>
      </span>
      <Link className="auth-link auth-link-end" href="/login/forgot-password">Forgot password?</Link>
      <button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      {passwordReset ? <p className="form-message" role="status">Your password has been reset. Sign in with your new password.</p> : null}
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
