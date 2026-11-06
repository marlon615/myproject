"use client";
import { useState } from "react";

export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <input type="text" readOnly value={value} onFocus={(e) => e.currentTarget.select()} aria-label={label} />
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          } catch {
            /* clipboard blocked: the input is still selectable */
          }
        }}
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}
