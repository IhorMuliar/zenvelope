import { useEffect, useRef, useState } from "react";

interface Props {
  label: string;
  value: string;
  /** A secret-bearing value is never selected into a URL bar or logged. */
  mono?: boolean;
  testId?: string;
}

export function CopyField({ label, value, mono = true, testId }: Props) {
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
    <div className="copy-field">
      <div className="copy-field-head">
        <span className="label">{label}</span>
        <button type="button" className="ghost" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <code className={mono ? "value mono" : "value"} data-testid={testId}>
        {value}
      </code>
    </div>
  );
}
