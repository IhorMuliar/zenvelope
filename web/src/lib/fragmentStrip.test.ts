/**
 * H1: the link secret leaves the URL bar as soon as it has been read.
 *
 * A Zenvelope link is a bearer capability. Until this landed it sat in
 * `location.hash` for the whole open → scan → prove flow — minutes, in the URL
 * bar, in the history entry, in whatever the browser syncs, and in anything the
 * recipient taps "share" on — while the page said the secret had stayed in the
 * browser. It had; it had also stayed in the address bar.
 *
 * `stripSecretFromUrl` is a pure function over the two pieces of `window` it
 * touches, so the rule can be checked without a DOM. The browser half of the
 * proof — that `location.hash` really is empty after an open, and that a reload
 * lands on the friendly "no envelope in this link" screen — is in
 * `e2e/m2-open.spec.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  LINK_FORGOTTEN_COPY,
  NO_FRAGMENT_COPY,
  stripSecretFromUrl,
  type UrlBar,
} from "./openFlow";

const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

/** A window's URL bar, and a record of every rewrite of it. */
function urlBar(pathname: string, search: string, hash: string) {
  const written: string[] = [];
  const win: UrlBar = {
    location: { pathname, search, hash },
    history: {
      replaceState(_data: unknown, _unused: string, url: string) {
        written.push(url);
        // A real replaceState updates what location reports next.
        win.location.hash = "";
      },
    },
  };
  return { win, written };
}

describe("taking the secret out of the URL", () => {
  it("rewrites the entry to the path and query, with no fragment", () => {
    const { win, written } = urlBar("/e", "", `#${SECRET}.3490472`);
    expect(stripSecretFromUrl(win)).toBe("/e");
    expect(written).toEqual(["/e"]);
    expect(win.location.hash).toBe("");
  });

  it("writes the secret nowhere: not into the URL it replaces it with", () => {
    const { written } = (() => {
      const bar = urlBar("/e", "?dry=1", `#${SECRET}.3490472`);
      stripSecretFromUrl(bar.win);
      return bar;
    })();
    for (const url of written) expect(url).not.toContain(SECRET);
  });

  it("keeps the query string, because ?dry, ?net, ?poll and ?threads live there", () => {
    const { win } = urlBar("/e", "?dry=1&threads=1", `#${SECRET}`);
    expect(stripSecretFromUrl(win)).toBe("/e?dry=1&threads=1");
  });

  it("replaces the entry rather than pushing one, so no entry is left holding it", () => {
    // `replaceState` is the whole point: a `pushState` would leave the previous
    // entry — the one with the secret in it — one Back press away.
    let pushed = 0;
    const win: UrlBar & { history: { pushState?: () => void } } = {
      location: { pathname: "/e", search: "", hash: `#${SECRET}` },
      history: {
        replaceState: () => {},
        pushState: () => {
          pushed += 1;
        },
      },
    };
    stripSecretFromUrl(win);
    expect(pushed).toBe(0);
  });

  it("does nothing when there is no fragment to strip", () => {
    const { win, written } = urlBar("/e", "", "");
    expect(stripSecretFromUrl(win)).toBeNull();
    expect(written).toEqual([]);
    const bare = urlBar("/e", "", "#");
    expect(stripSecretFromUrl(bare.win)).toBeNull();
    expect(bare.written).toEqual([]);
  });

  it("survives a browser that refuses replaceState, without breaking the open", () => {
    const win: UrlBar = {
      location: { pathname: "/e", search: "", hash: `#${SECRET}` },
      history: {
        replaceState() {
          throw new DOMException("SecurityError");
        },
      },
    };
    // A worse URL bar, and nothing more: the secret is already in memory and the
    // flow never reads the hash again.
    expect(stripSecretFromUrl(win)).toBeNull();
  });
});

describe("what the screens say about it", () => {
  it("tells the recipient to keep the original link", () => {
    expect(LINK_FORGOTTEN_COPY).toMatch(/Keep the original link/);
    expect(LINK_FORGOTTEN_COPY).toMatch(/forgets it when reloaded/);
  });

  it("explains the reload on the no-fragment screen, rather than blaming the link", () => {
    expect(NO_FRAGMENT_COPY).toMatch(/forgets the link/);
    expect(NO_FRAGMENT_COPY).toMatch(/open the original link again/i);
  });

  it("says nothing that could be read as a drainer lure", () => {
    for (const line of [LINK_FORGOTTEN_COPY, NO_FRAGMENT_COPY]) {
      expect(line.toLowerCase()).not.toContain("claim");
    }
  });
});
