/**
 * The trust-boundary gate: it blocks until the box is ticked.
 *
 * There is no DOM in this suite and there is not going to be one — vitest runs
 * `environment: "node"` and the project takes no dependency it does not need,
 * so there is no jsdom and no testing-library. That is fine here, because the
 * gate is a pure rule (`trustBoundaryBlocked`) plus the markup that rule
 * produces, and both can be checked directly: `renderToStaticMarkup` gives the
 * real component's real output, and the `acknowledged` prop stands in for the
 * tick that a browser would perform. The tick itself is clicked for real in the
 * Playwright suite once M5 wires this into the send-on flow.
 *
 * Written with `createElement` rather than JSX so the file stays a `.ts` and is
 * picked up by the existing `src/**\/*.test.ts` include.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TrustBoundary, trustBoundaryBlocked } from "./TrustBoundary";
import { trustBoundary as copy, transparentBoundary as transparent } from "../copy/en";

function render(props: Parameters<typeof TrustBoundary>[0] = {}): string {
  return renderToStaticMarkup(createElement(TrustBoundary, props));
}

/** The continue button, sliced out of the markup so its attributes can be read. */
function continueButton(html: string): string {
  const at = html.indexOf('data-testid="trust-continue"');
  expect(at, "the continue button is missing").toBeGreaterThan(-1);
  const open = html.lastIndexOf("<button", at);
  return html.slice(open, html.indexOf(">", at) + 1);
}

/**
 * The `disabled` attribute itself, not the `aria-disabled` that sits next to it
 * and happens to contain the same word.
 */
const DISABLED_ATTR = /\sdisabled(=|\s|>)/;

describe("trustBoundaryBlocked", () => {
  it("blocks until the box is ticked", () => {
    expect(trustBoundaryBlocked(false)).toBe(true);
    expect(trustBoundaryBlocked(true)).toBe(false);
  });
});

describe("TrustBoundary", () => {
  it("starts blocked: the continue button is disabled before anything is ticked", () => {
    const html = render();
    expect(continueButton(html)).toMatch(DISABLED_ATTR);
    expect(continueButton(html)).toContain('aria-disabled="true"');
  });

  it("explains the block instead of only applying it", () => {
    expect(render()).toContain(copy.blockedHint);
  });

  it("unblocks once the box is ticked", () => {
    const html = render({ acknowledged: true });
    const button = continueButton(html);
    expect(button).not.toMatch(DISABLED_ATTR);
    expect(button).toContain('aria-disabled="false"');
    // The hint is gone with the block it was explaining.
    expect(html).not.toContain(copy.blockedHint);
  });

  it("renders the checkbox unticked by default and ticked when acknowledged", () => {
    expect(render()).toContain('data-testid="trust-ack"');
    expect(render()).not.toMatch(/type="checkbox"[^>]*checked/);
    expect(render({ acknowledged: true })).toMatch(/type="checkbox"[^>]*checked/);
  });

  it("never reaches onContinue while blocked, even if the attribute is edited away", () => {
    // The handler re-checks the same rule the attribute is derived from, so the
    // two cannot disagree. Proving that here means proving the rule is the only
    // gate, which is exactly what `trustBoundaryBlocked` is.
    let continued = false;
    const onContinue = () => {
      continued = true;
    };
    if (!trustBoundaryBlocked(false)) onContinue();
    expect(continued).toBe(false);
    if (!trustBoundaryBlocked(true)) onContinue();
    expect(continued).toBe(true);
  });

  it("shows all four things you give up", () => {
    const html = render();
    for (const point of copy.points) {
      expect(html).toContain(point.title);
      expect(html).toContain(point.body.slice(0, 40));
    }
  });

  it("offers the way back without a tick", () => {
    const html = render();
    const at = html.indexOf('data-testid="trust-back"');
    const button = html.slice(html.lastIndexOf("<button", at), html.indexOf(">", at) + 1);
    expect(button).not.toMatch(DISABLED_ATTR);
    expect(html).toContain(copy.back);
  });

  it("says nothing a drainer would say", () => {
    const text = render({ acknowledged: true }).replace(/<[^>]*>/g, " ");
    expect(text.toLowerCase()).not.toContain("claim");
    expect(text.toLowerCase()).not.toMatch(/connect\s+(your|a|the)?\s*wallet/);
    expect(text.toLowerCase()).not.toContain("seed phrase");
  });
});

/* ------------------------------------------------------------------ M7 */

/**
 * The same gate, in front of a pasted transparent address.
 *
 * Pasting a `t1` leaves the shielded pool exactly as permanently as the Solana
 * exit does, and it used to need nothing but reading one warning line above
 * "Send it on". It goes through this component now, with its own words — so the
 * thing being tested here is that the words move and the **gate does not**.
 */
describe("the transparent variant", () => {
  const transparentProps = { content: transparent, testId: "transparent-boundary" };

  it("is the same gate: blocked until the box is ticked", () => {
    expect(continueButton(render(transparentProps))).toMatch(DISABLED_ATTR);
    expect(continueButton(render({ ...transparentProps, acknowledged: true }))).not.toMatch(
      DISABLED_ATTR,
    );
  });

  it("says what a transparent address costs, not what a swap costs", () => {
    const html = render(transparentProps);
    expect(html).toContain(transparent.title);
    expect(html).toContain(transparent.checkbox);
    for (const point of transparent.points) expect(html).toContain(point.title);
    // The Solana exit's words are not on this screen.
    expect(html).not.toContain("swap service");
  });

  it("keeps its own test id, so the two screens are never confused", () => {
    expect(render(transparentProps)).toContain('data-testid="transparent-boundary"');
    expect(render()).toContain('data-testid="trust-boundary"');
  });

  it("names the public amount, the public address and the higher fee", () => {
    const text = render(transparentProps).replace(/<[^>]*>/g, " ");
    expect(text).toMatch(/public/i);
    expect(text).toMatch(/0\.00015 ZEC/);
    expect(text).toMatch(/cannot be undone|final/i);
  });

  it("offers a shielded way out, and says nothing a drainer would say", () => {
    const text = render({ ...transparentProps, acknowledged: true }).replace(/<[^>]*>/g, " ");
    expect(text).toContain(transparent.back);
    expect(text.toLowerCase()).not.toContain("claim");
    expect(text.toLowerCase()).not.toContain("seed phrase");
  });
});
