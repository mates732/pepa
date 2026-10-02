"use client";

import { useEffect, useRef, useState } from "react";

import { parseOutreachInput } from "@/lib/parser";
import type { ParsedOutreachInput } from "@/lib/types";

interface PasteImportProps {
  onParsed: (parsed: ParsedOutreachInput, raw: string) => void;
  onError: (message: string) => void;
  focusSignal: number;
  disabled: boolean;
}

export function PasteImport({ onParsed, onError, focusSignal, disabled }: PasteImportProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusSignal > 0) textareaRef.current?.focus();
  }, [focusSignal]);

  function handleParse() {
    if (!value.trim()) {
      onError("Nothing to parse — paste the recipient, subject and body first.");
      textareaRef.current?.focus();
      return;
    }
    const parsed = parseOutreachInput(value);
    if (parsed.missing.includes("recipient")) {
      onError(
        "No recipient email found. Use a line like `recipient: info@example.com`.",
      );
      return;
    }
    onParsed(parsed, value);
  }

  return (
    <section className="rounded-lg border border-neutral-200 bg-white shadow-sm">
      <header className="flex items-baseline justify-between border-b border-neutral-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-neutral-900">1 · Paste / Import</h2>
        <span className="text-xs text-neutral-500">
          <kbd className="rounded border border-neutral-300 bg-neutral-50 px-1.5 py-0.5 font-sans text-[11px]">
            ⌘
          </kbd>
          <span className="mx-0.5">+</span>
          <kbd className="rounded border border-neutral-300 bg-neutral-50 px-1.5 py-0.5 font-sans text-[11px]">
            ↵
          </kbd>{" "}
          to parse
        </span>
      </header>

      <div className="p-4">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              handleParse();
            }
          }}
          disabled={disabled}
          rows={12}
          spellCheck={false}
          placeholder={
            "recipient: info@example.com\nsubject: AI recepce pro Example\nbody: Dobrý den,\n\nchtěl jsem Vám ukázat..."
          }
          className="w-full resize-y rounded-md border border-neutral-300 bg-neutral-50 p-3 font-mono text-[13px] leading-relaxed text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-900 focus:bg-white focus:ring-1 focus:ring-neutral-900 disabled:opacity-60"
        />

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={handleParse}
            disabled={disabled}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
          >
            Parse &amp; check duplicates
          </button>
          <button
            type="button"
            onClick={() => setValue("")}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
          >
            Clear paste
          </button>
        </div>
      </div>
    </section>
  );
}