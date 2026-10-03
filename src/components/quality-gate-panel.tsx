"use client";

import type { QualityCheck, QualityGateResult } from "@/lib/outreach/quality-gate";
import type { GateEvaluation } from "@/lib/services/outreach-quality-gate";

/**
 * Compact quality-gate readout for the composer.
 *
 * The operator has to be able to answer "why is this not ready?" without
 * opening a log, so every non-passing check renders its reason. Passing checks
 * render as a short label only, because a wall of green ticks buries the one
 * line that matters.
 *
 * Monochrome by design: PEPA's palette is off-white and midnight only, so state
 * is carried by glyph density and border weight, never by a new hue.
 */

/** Short labels for passing checks. The reason text stays out of the way. */
const PASS_LABEL: Record<string, string> = {
  recipient: "Recipient valid",
  identity: "No duplicate outreach",
  subject_present: "Subject present",
  subject_unique: "Subject unique",
  body_present: "Body has length",
  body_unique: "Body unique",
  placeholders: "No placeholders",
  ai_artifacts: "No AI artefacts",
  personalization: "Personalisation supported",
};

const GLYPH = {
  pass: "✓",
  warn: "⚠",
  block: "✕",
} as const;

const VERDICT: Record<QualityGateResult["status"], string> = {
  ready: "READY",
  warning: "WARNING",
  blocked: "BLOCKED",
};

function label(check: QualityCheck): string {
  return PASS_LABEL[check.name] ?? check.name.replace(/_/g, " ");
}

export function QualityGatePanel({
  gate,
  pending,
}: {
  gate: GateEvaluation | null;
  pending: boolean;
}) {
  if (!gate) {
    // Nothing evaluated yet. Never render an implicit "ready".
    return (
      <div className="border-t-[3px] border-dashed border-midnight-line pt-4">
        <p className="field-label">Quality gate</p>
        <p className="text-xs text-midnight-soft">
          {pending ? "Evaluating…" : "Waiting for a recipient, subject and body."}
        </p>
      </div>
    );
  }

  const blocking = gate.checks.filter((check) => check.status === "block");
  const warning = gate.checks.filter((check) => check.status === "warn");
  const passing = gate.checks.filter((check) => check.status === "pass");

  return (
    <div className="border-t-[3px] border-dashed border-midnight-line pt-4">
      <div className="flex items-center justify-between gap-2">
        <p className="field-label">Quality gate</p>
        <span
          className={
            gate.status === "ready" ? "chip" : "chip chip-solid"
          }
        >
          {pending ? "…" : VERDICT[gate.status]}
        </span>
      </div>

      <ul className="mt-2 space-y-1">
        {passing.map((check) => (
          <li key={check.name} className="flex gap-2 text-xs text-midnight-soft">
            <span aria-hidden className="font-bold text-midnight">
              {GLYPH.pass}
            </span>
            <span>{label(check)}</span>
          </li>
        ))}

        {warning.map((check) => (
          <li key={check.name} className="flex gap-2 text-xs font-semibold text-midnight">
            <span aria-hidden className="font-black">
              {GLYPH.warn}
            </span>
            <span>
              {label(check)}
              <span className="block font-normal text-midnight-soft">{check.reason}</span>
            </span>
          </li>
        ))}

        {blocking.map((check) => (
          <li key={check.name} className="flex gap-2 text-xs font-bold text-midnight">
            <span aria-hidden className="font-black">
              {GLYPH.block}
            </span>
            <span>
              {label(check)}
              <span className="block font-semibold">{check.reason}</span>
            </span>
          </li>
        ))}
      </ul>

      {gate.status === "blocked" ? (
        <p className="notice notice-alarm mt-3">
          This draft cannot be recorded as sent until the blocked checks above are resolved.
        </p>
      ) : null}

      {gate.status === "warning" && warning.length > 0 ? (
        <p className="notice mt-3">
          Recording this as sent will ask you to confirm the warnings first.
        </p>
      ) : null}
    </div>
  );
}