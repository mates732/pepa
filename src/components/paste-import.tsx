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
    <section className="sticker">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b-[3px] border-midnight px-5 py-3">
        <h2 className="heading-sticker text-base text-midnight">
          <span className="chip chip-solid mr-2 align-middle">1</span>
          Paste / Import
        </h2>
        <span className="text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
          ⌘ + ↵ to parse
        </span>
      </header>

      <div className="p-5">
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
          rows={11}
          spellCheck={false}
          placeholder={
            "recipient: info@example.com\nsubject: AI recepce pro Example\nbody: Dobrý den,\n\nchtěl jsem Vám ukázat..."
          }
          className="field resize-y font-mono text-[13px] leading-relaxed"
        />

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" onClick={handleParse} disabled={disabled} className="btn btn-primary">
            Parse &amp; check duplicates
          </button>
          <button type="button" onClick={() => setValue("")} className="btn">
            Clear paste
          </button>
        </div>
      </div>
    </section>
  );
}