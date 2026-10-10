import "server-only";

import { getAuthEnvStatus, MIN_PASSWORD_LENGTH, MIN_SECRET_LENGTH } from "./env";

/**
 * Preview-only, explicitly-enabled visibility gate for the temporary auth
 * diagnostics.
 *
 * Intentional default: diagnostic is OFF unless BOTH of these are true:
 *   - VERCEL_ENV === "preview"
 *   - PEPA_ENABLE_AUTH_DIAGNOSTICS === "true"
 *
 * Production never renders the panel, even if the flag is set to "true".
 *
 * This is a server-side environment check only. It cannot be enabled from a
 * client query parameter.
 */
export function authDiagnosticsEnabled(): boolean {
  if (process.env.VERCEL_ENV !== "preview") return false;
  return process.env.PEPA_ENABLE_AUTH_DIAGNOSTICS === "true";
}

/**
 * Cheap, safe diagnostics for the auth environment only.
 *
 * Public surface reports booleans and length RATINGS only. It never includes any
 * variable value, prefix, or substring; it is safe to print in logs and useful
 * when a deployment says "Server is not configured" despite an environment
 * listing that appears to contain both variables.
 */
export function authEnvDiagnostics() {
  const password = process.env.PEPA_PASSWORD;
  const secret = process.env.PEPA_SESSION_SECRET;

  const passwordPresent = typeof password === "string" && password.length > 0;
  const secretPresent =
    typeof secret === "string" && secret.length > 0;

  const passwordMeetsMinimum =
    passwordPresent && password.length >= MIN_PASSWORD_LENGTH;
  const secretMeetsMinimum =
    secretPresent && secret.length >= MIN_SECRET_LENGTH;

  const configured = passwordMeetsMinimum && secretMeetsMinimum;

  return {
    phase: "request-runtime",
    passwordPresent,
    passwordMeetsMinimum,
    passwordLengthValid: passwordMeetsMinimum,
    secretPresent,
    secretMeetsMinimum,
    secretLengthValid: secretMeetsMinimum,
    configured,
    // For diagnostics only: still no value.
    //
    // This is intentionally not exposed to clients and is not sent anywhere.
    reason:
      !passwordPresent
        ? "PEPA_PASSWORD is missing or empty"
        : !passwordMeetsMinimum
          ? "PEPA_PASSWORD is too short"
          : !secretPresent
            ? "PEPA_SESSION_SECRET is missing or empty"
            : !secretMeetsMinimum
              ? "PEPA_SESSION_SECRET is too short"
              : "configured",
  };
}
