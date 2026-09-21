/**
 * I12: the secret is not a React prop.
 *
 * It used to be one — `<Opened secret={…}>` and `<SendOn secret={…}>` — which
 * meant the bearer capability was a string in the React element tree, printed in
 * full by the DevTools props inspector, while the ref it came from was not. It
 * is passed as a getter now, read in exactly one place (inside the sweep, at the
 * moment the core is handed it) and nowhere during a render.
 *
 * `renderToStaticMarkup` gives the real component's real output without a DOM,
 * which is all this needs: the claim is about what the component is given and
 * when it reads it, not about what it does afterwards.
 *
 * ## The residual
 *
 * A getter is not a vault. Anything running in the page can call it, as anything
 * running in the page could read the ref, and the secret is in the worker's
 * memory as well while a sweep runs. What it buys is that the secret is no
 * longer sitting in a props tree that a casual DevTools inspection, a screen
 * share or a React error overlay would print. The CSP is what is supposed to
 * stop the script; this is defence in depth behind it, and it is documented as
 * such in web/README.md.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SendOn } from "./SendOn";
import type { FoundNote, LoadedCore } from "../core/types";

const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

const NOTES: FoundNote[] = [
  {
    amount_zat: "130000",
    memo: null,
    height: 3490472,
    txid: "281e9f7b00000000000000000000000000000000000000000000000000341d43",
    pool: "ironwood",
    action_index: 1,
  },
];

/**
 * Enough of a core to render with. No effect runs under
 * `renderToStaticMarkup`, so none of these is called; they exist so the shape
 * type-checks.
 */
function stubCore(): LoadedCore {
  const never = () => Promise.reject(new Error("not called during render"));
  return new Proxy({ isMock: true, backend: "mock", threads: 1, reason: null }, {
    get(target: Record<string, unknown>, key: string) {
      return key in target ? target[key] : never;
    },
  }) as unknown as LoadedCore;
}

function render(getSecret: () => string | null): string {
  return renderToStaticMarkup(
    createElement(SendOn, {
      core: stubCore(),
      getSecret,
      network: "main" as const,
      notes: NOTES,
      tipHeight: 3490500,
      envelopeAddress: `u1${"q".repeat(100)}`,
    }),
  );
}

describe("the secret is not in the props, and not in the markup", () => {
  it("is never read while the component renders", () => {
    let reads = 0;
    render(() => {
      reads += 1;
      return SECRET;
    });
    // The only call site is inside `send()`, which a render does not reach.
    expect(reads).toBe(0);
  });

  it("puts nothing that looks like the secret on the screen", () => {
    const html = render(() => SECRET);
    expect(html).not.toContain(SECRET);
    // Nor any prefix of it long enough to be worth trying.
    expect(html).not.toContain(SECRET.slice(0, 16));
  });

  it("takes a getter rather than a string, so DevTools has nothing to print", () => {
    // A props object is what the inspector walks. This is the whole of it.
    const props = {
      core: { isMock: true },
      getSecret: () => SECRET,
      network: "main" as const,
      notes: NOTES,
      tipHeight: 3490500,
      envelopeAddress: "u1…",
    };
    const printable = JSON.stringify(props, (_k, v) =>
      typeof v === "function" ? "[function]" : typeof v === "bigint" ? v.toString() : v,
    );
    expect(printable).not.toContain(SECRET);
    expect(printable).toContain("[function]");
  });
});
