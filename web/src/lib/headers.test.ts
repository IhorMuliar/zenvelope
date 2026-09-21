/**
 * H2/L8: the security headers exist, agree with each other, and cannot quietly
 * stop being delivered.
 *
 * The CSP is the only thing between an injected script and `location.hash`, and
 * until this landed it lived in exactly one Netlify/Cloudflare-Pages header file
 * with no host configuration committed and no `<meta>` fallback: served by
 * anything else, the app shipped with no CSP, no COOP/COEP and no
 * `frame-ancestors`, silently. Three files carry it now — `public/_headers`,
 * `netlify.toml` and a `<meta http-equiv>` in `index.html` — and the point of
 * this test is that they say the same thing. A policy that drifts between hosts
 * is a policy nobody can reason about.
 *
 * Two directives are deliberately absent from the meta: `frame-ancestors`, which
 * a meta CSP cannot express at all (the headers carry it, and `X-Frame-Options:
 * DENY` backs it up), and nothing else.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(resolve(WEB, rel), "utf8");

const HEADERS = read("public/_headers");
const NETLIFY = read("netlify.toml");
const INDEX = read("index.html");

/** `name: value` out of the Cloudflare/Netlify `_headers` file. */
function headerValue(name: string): string {
  const line = HEADERS.split("\n").find((l) => l.trim().toLowerCase().startsWith(`${name.toLowerCase()}:`));
  expect(line, `${name} is missing from public/_headers`).toBeTruthy();
  return line!.slice(line!.indexOf(":") + 1).trim();
}

/** `Name = "value"` out of netlify.toml. */
function netlifyValue(name: string): string {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, "m").exec(NETLIFY);
  expect(match, `${name} is missing from netlify.toml`).toBeTruthy();
  return match![1].trim();
}

/** A policy string as a map of directive to its sources. */
function directives(policy: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of policy.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const space = trimmed.indexOf(" ");
    out.set(
      space === -1 ? trimmed : trimmed.slice(0, space),
      space === -1 ? "" : trimmed.slice(space + 1).trim(),
    );
  }
  return out;
}

const metaCsp = (() => {
  const match = /http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]*)"/.exec(INDEX);
  expect(match, "index.html carries no CSP meta").toBeTruthy();
  return match![1];
})();

describe("the header file every host reads", () => {
  it("is cross-origin isolated, so the threaded core can start", () => {
    expect(headerValue("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(headerValue("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(headerValue("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });

  it("refuses to be framed, twice over", () => {
    expect(headerValue("X-Frame-Options")).toBe("DENY");
    expect(directives(headerValue("Content-Security-Policy")).get("frame-ancestors")).toBe("'none'");
  });

  it("sends no referrer and sniffs no types", () => {
    expect(headerValue("Referrer-Policy")).toBe("no-referrer");
    expect(headerValue("X-Content-Type-Options")).toBe("nosniff");
    expect(INDEX).toContain('name="referrer" content="no-referrer"');
  });

  /* --------------------------------------------------------------------- L8 */

  it("pins HTTPS for a year, subdomains included", () => {
    // A link is a bearer capability, so one downgrade to http is a disclosed
    // secret. `preload` is left off until there is a domain of our own (D9).
    const hsts = "max-age=31536000; includeSubDomains";
    expect(headerValue("Strict-Transport-Security")).toBe(hsts);
    expect(netlifyValue("Strict-Transport-Security")).toBe(hsts);
  });
});

describe("the CSP says the same thing wherever it comes from", () => {
  const fromHeaders = directives(headerValue("Content-Security-Policy"));
  const fromNetlify = directives(netlifyValue("Content-Security-Policy"));
  const fromMeta = directives(metaCsp);

  it("is byte-for-byte the same in _headers and netlify.toml", () => {
    expect(netlifyValue("Content-Security-Policy")).toBe(headerValue("Content-Security-Policy"));
  });

  it("locks everything down by default", () => {
    for (const policy of [fromHeaders, fromNetlify, fromMeta]) {
      expect(policy.get("default-src")).toBe("'none'");
      expect(policy.get("base-uri")).toBe("'none'");
      expect(policy.get("object-src")).toBe("'none'");
      expect(policy.get("form-action")).toBe("'none'");
    }
  });

  it("allows the wasm core and nothing else to run", () => {
    for (const policy of [fromHeaders, fromMeta]) {
      expect(policy.get("script-src")).toBe("'self' 'wasm-unsafe-eval'");
      expect(policy.get("worker-src")).toBe("'self' blob:");
      // No 'unsafe-inline', no 'unsafe-eval', anywhere in it.
      for (const sources of policy.values()) {
        expect(sources).not.toContain("'unsafe-inline'");
        expect(sources).not.toMatch(/'unsafe-eval'/);
      }
    }
  });

  it("lets the browser reach the two lightwalletd pairs and the rail, and nothing else", () => {
    const expected =
      "'self' https://zjs.zec.rocks https://zcash-mainnet.chainsafe.dev " +
      "https://zcash-testnet.chainsafe.dev https://1click.chaindefuser.com";
    expect(fromHeaders.get("connect-src")).toBe(expected);
    expect(fromMeta.get("connect-src")).toBe(expected);
  });

  it("is the same policy in the meta, minus what a meta cannot express", () => {
    // The one documented difference. If anything else drifts, this fails.
    const METAS_CANNOT = new Set(["frame-ancestors"]);
    const missing = [...fromHeaders.keys()].filter((d) => !fromMeta.has(d));
    expect(missing).toEqual([...METAS_CANNOT]);
    for (const [directive, sources] of fromMeta) {
      expect(fromHeaders.get(directive), directive).toBe(sources);
    }
  });
});

describe("the host configuration is committed, not folklore", () => {
  it("builds and publishes the app the way the README says", () => {
    expect(NETLIFY).toMatch(/base\s*=\s*"web"/);
    expect(NETLIFY).toMatch(/publish\s*=\s*"dist"/);
  });

  it("keeps the single-page redirect that public/_redirects has", () => {
    expect(NETLIFY).toMatch(/to\s*=\s*"\/index\.html"/);
    expect(read("public/_redirects")).toContain("/index.html");
  });

  it("holds no secret: the fee address comes from the build environment", () => {
    expect(NETLIFY).not.toMatch(/VITE_FEE_ADDRESS\s*=\s*"u1/);
    expect(HEADERS).not.toContain("u1");
  });
});
