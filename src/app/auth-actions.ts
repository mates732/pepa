"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { clearSessionCookie, setSessionCookie } from "@/lib/auth/cookie";
import { safeRedirectPath } from "@/lib/auth/dal";
import { getAuthEnvStatus, verifyPassword } from "@/lib/auth/env";
import {
  enforceCapacity,
  loginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
} from "@/lib/auth/rate-limit";

/**
 * Single generic failure message for every failure mode. Never reveals whether
 * a password was close, nor anything about server configuration.
 */
const GENERIC_ERROR = "Invalid credentials.";

export interface LoginState {
  error: string | null;
}

/** Client-supplied header; Vercel sets it, harmless locally. */
async function clientKey(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
  return ip;
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const key = await clientKey();
  enforceCapacity(key);

  const gate = loginAllowed(key);
  if (!gate.allowed) {
    // Do not reveal that the account exists; the throttle is generic too.
    return { error: "Too many attempts. Try again shortly." };
  }

  const password = formData.get("password");
  const next = safeRedirectPath(formData.get("next") as string | null);

  if (!getAuthEnvStatus().configured || !verifyPassword(typeof password === "string" ? password : null)) {
    recordLoginFailure(key);
    return { error: GENERIC_ERROR };
  }

  recordLoginSuccess(key);
  await setSessionCookie();

  // redirect() throws a control-flow exception: it must stay outside try/catch.
  redirect(next);
}

export async function logout(): Promise<void> {
  await clearSessionCookie();
  redirect("/login");
}