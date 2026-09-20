import { useEffect, useState } from "react";
import { loadCore } from "../core";
import type { Network } from "../core/types";

interface Found {
  address: string;
  birthday?: number;
  network: Network;
  isMock: boolean;
}

export function Open() {
  const [found, setFound] = useState<Found | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const frag = window.location.hash.replace(/^#/, "");
    const network: Network =
      new URLSearchParams(window.location.search).get("net") === "test" ? "test" : "main";

    if (frag.trim() === "") {
      setError(
        "This link has no envelope in it. Links look like /e#… and the part after the # " +
          "is dropped by some chat apps, so copy the whole link and try again.",
      );
      return;
    }

    loadCore()
      .then((core) => {
        // parse and derive locally; the fragment never leaves the browser
        const parsed = core.parse_fragment(frag);
        const derived = core.derive(parsed.secret, network);
        if (!alive) return;
        setFound({
          address: derived.address,
          birthday: parsed.birthday,
          network,
          isMock: core.isMock,
        });
      })
      .catch(() => {
        if (alive) {
          setError("This link does not contain a valid envelope. Check that you copied all of it.");
        }
      });

    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <section className="stack">
        <h1>We could not read this link</h1>
        <p className="error">{error}</p>
        <p>
          <a href="/">Create an envelope instead</a>
        </p>
      </section>
    );
  }

  if (!found) {
    return (
      <section className="stack">
        <h1>Reading the link…</h1>
      </section>
    );
  }

  return (
    <section className="stack">
      <h1>Envelope found</h1>
      {found.isMock ? (
        <p className="badge">
          MOCK CORE — no WASM build found. This address is a placeholder.
        </p>
      ) : null}
      <div className="card stack">
        <p data-testid="open-placeholder">Envelope found, opening arrives in the next milestone.</p>
        <span className="label">Envelope address</span>
        <code className="value mono" data-testid="open-address">
          {found.address}
        </code>
        <p className="hint">
          {found.birthday !== undefined
            ? `Birthday height ${found.birthday}.`
            : "No birthday in this link."}
          {found.network === "test" ? " Testnet." : ""}
        </p>
      </div>
      <p className="fine">
        The secret in this link stayed in your browser. Nothing about it was sent anywhere.
      </p>
    </section>
  );
}
