import { useEffect, useRef, useState } from "react";

interface Props {
  value: string;
  /** For a screen reader: "Copy link for envelope 3", not twelve identical "Copy"s. */
  label: string;
  /** What the button says before it is pressed. "Copy" unless a caller says otherwise. */
  face?: string;
  testId?: string;
}

/**
 * A copy button on its own, for places where a labelled `CopyField` would be
 * too much furniture — a table cell, mostly.
 *
 * The clipboard is the only place the value goes. Nothing is logged, nothing is
 * stored, and the fallback path removes its textarea before it returns.
 */
export function CopyButton({ value, label, face = "Copy", testId }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const el = document.createElement("textarea");
      el.value = value;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      el.remove();
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <button type="button" className="ghost copy-btn" aria-label={label} data-testid={testId} onClick={copy}>
      {copied ? "Copied" : face}
    </button>
  );
}
