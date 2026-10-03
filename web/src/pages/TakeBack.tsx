import { useState } from "react";
import { takeBack as copy } from "../copy/en";

/**
 * Where a pasted link may go: an `/e#…` link on this very site, and nothing
 * else. The check is on the parsed URL, not a prefix match, so a look-alike
 * host or a link to somewhere else is refused rather than followed.
 */
export function envelopeLinkTarget(
  input: string,
  origin: string,
): { ok: true; url: string } | { ok: false; reason: "notHere" | "noSecret" } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: "notHere" };
  }
  const here = new URL(origin);
  if (url.protocol !== here.protocol || url.host !== here.host) return { ok: false, reason: "notHere" };
  if (url.pathname.replace(/\/+$/, "") !== "/e") return { ok: false, reason: "notHere" };
  if (url.hash.replace(/^#/, "").trim() === "") return { ok: false, reason: "noSecret" };
  return { ok: true, url: url.href };
}

/**
 * `/back`: paste your own envelope link and open it, to send the money back to
 * yourself while it is still unopened. Nothing is kept: the link goes straight
 * to the open page, which strips it from the address bar as it always does.
 */
export function TakeBack() {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="stack">
      <h1>{copy.title}</h1>
      <p className="lede">{copy.lede}</p>
      <form
        className="card stack"
        onSubmit={(e) => {
          e.preventDefault();
          const target = envelopeLinkTarget(input, window.location.origin);
          if (!target.ok) {
            setError(target.reason === "noSecret" ? copy.noSecret : copy.notHere);
            return;
          }
          setError(null);
          window.location.assign(target.url);
        }}
      >
        <label className="field">
          <span className="label strong">{copy.label}</span>
          <input
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={copy.placeholder}
            value={input}
            aria-invalid={error !== null}
            onChange={(e) => {
              setInput(e.target.value);
              setError(null);
            }}
            data-testid="take-back-input"
          />
        </label>
        {error ? (
          <p className="error" role="alert" data-testid="take-back-error">
            {error}
          </p>
        ) : null}
        <button type="submit" className="primary" data-testid="take-back-open">
          {copy.submit}
        </button>
      </form>
      <p className="hint">{copy.note}</p>
    </section>
  );
}
