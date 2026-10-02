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
    <form action={formAction} className="mt-6 space-y-3">
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
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 disabled:opacity-60"
        />
      </label>

      <button
        type="submit"
        disabled={disabled || pending}
        className="w-full rounded-md bg-neutral-900 px-3 py-2 text-sm font-semibold uppercase tracking-wide text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
      >
        {disabled ? "Not configured" : pending ? "Verifying…" : "Enter PEPA"}
      </button>

      {state.error ? (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
        >
          {state.error}
        </p>
      ) : null}
    </form>
  );
}