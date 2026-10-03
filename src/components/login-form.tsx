"use client";

import { useActionState } from "react";

import { login, type LoginState } from "@/app/auth-actions";

const INITIAL: LoginState = { error: null };

interface LoginFormProps {
  /** Sanitised by safeRedirectPath() on the server before it is ever used. */
  next: string;
  disabled: boolean;
}

export function LoginForm({ next, disabled }: LoginFormProps) {
  const [state, formAction, pending] = useActionState(login, INITIAL);

  return (
    <form action={formAction} className="mt-7 space-y-4">
      <input type="hidden" name="next" value={next} />

      <label className="block">
        <span className="sr-only">Password</span>
        <input
          type="password"
          name="password"
          required
          autoFocus
          autoComplete="current-password"
          disabled={disabled || pending}
          placeholder="Password"
          className="field text-center tracking-[0.3em]"
        />
      </label>

      <button
        type="submit"
        disabled={disabled || pending}
        className="btn btn-primary btn-lg w-full"
      >
        {disabled ? "Not configured" : pending ? "Verifying…" : "Enter PEPA"}
      </button>

      {state.error ? (
        <p role="alert" className="notice notice-alarm">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}