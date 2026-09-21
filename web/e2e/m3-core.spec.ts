/**
 * M3 end-to-end proof: a browser builds and PROVES a real mainnet Ironwood sweep.
 *
 *   ZENV_M1_FRAGMENT='<secret>.<birthday>' \
 *   ZENV_M3_DEST_ADDRESS='u1…' ZENV_M3_FEE_ADDRESS='u1…' \
 *   npm run e2e -- e2e/m3-core.spec.ts
 *
 * The fragment is the money, so it is never committed and never printed. All three
 * values live in the private M1-FUND.md and M3-DEST.md in the main checkout, are read
 * from the environment at run time, and the test skips cleanly when they are absent —
 * which is what CI and a fresh checkout see.
 *
 * What it proves:
 *   - `warm_proving_key()` builds the Orchard/Ironwood proving key inside the page, so
 *     the cost is paid before the recipient asks for anything
 *   - `sweep_envelope()` re-derives the note from the secret, witnesses it against the
 *     chain's own Ironwood tree, builds a 2-action bundle and PROVES it in wasm
 *   - the stage callbacks fire in the documented order
 *   - the result is a real transaction: a raw hex body and a txid
 *
 * It NEVER broadcasts. `broadcast: false` is passed explicitly and asserted on the way
 * out. Sending the real sweep is a separate step, triggered by hand.
 *
 * The key-build and proving wall times are printed, because they are the numbers the
 * open flow is budgeted against.
 */

import { expect, test } from "@playwright/test";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_ASSETS = resolve(HERE, "../dist/assets");

const LIGHTWALLETD = "https://zjs.zec.rocks/mainnet";

/** The M1 envelope's Ironwood note, as the native integration test pins it down. */
const NOTE = {
  txid: "281e9f7bffa5bffc8ee1287cc6e245cc59eee302727ea9d93c7f8e5a99341d43",
  height: 3_490_472,
  action_index: 1,
};
const NOTE_VALUE_ZAT = 130_000;
const FEE_ZAT = 30_000;
const NETWORK_FEE_ZAT = 10_000;

interface SweepResult {
  txid: string;
  raw_tx_hex: string | null;
  amount_to_destination_zat: string;
  fee_zat: string;
  network_fee_zat: string;
  anchor_height: number;
  broadcast: boolean;
  error_code: number | null;
  error_message: string | null;
}

/** Splits `<secret>.<birthday>` without going through the app. */
function parseFragment(fragment: string): { secret: string; birthday?: number } {
  const raw = fragment.trim().replace(/^#/, "");
  const dot = raw.indexOf(".");
  if (dot < 0) return { secret: raw };
  return { secret: raw.slice(0, dot), birthday: Number(raw.slice(dot + 1)) };
}

/**
 * A blank same-origin page that does NOT run the app.
 *
 * `/` boots React, which imports the same wasm chunk and initialises it. A second
 * importer in the page then races that init and the renderer dies. So the sweep gets a
 * page of its own, served by request interception with the production isolation headers.
 */
const HARNESS_PATH = "/__m3-core-harness";

async function openHarness(page: import("@playwright/test").Page) {
  await page.route(`**${HARNESS_PATH}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: {
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
      },
      body: "<!doctype html><meta charset=utf-8><title>m3 harness</title>",
    }),
  );
  await page.goto(HARNESS_PATH);
}

/** The wasm-bindgen glue chunk vite emitted, served verbatim from /assets. */
function glueUrl(): string {
  const file = readdirSync(DIST_ASSETS).find(
    (f) => f.startsWith("zenvelope_core-") && f.endsWith(".js"),
  );
  if (!file) throw new Error("no zenvelope_core-*.js in dist/assets; run npm run build");
  return `/assets/${file}`;
}

const FRAGMENT = process.env.ZENV_M1_FRAGMENT;
const DESTINATION = process.env.ZENV_M3_DEST_ADDRESS;
const FEE_ADDRESS = process.env.ZENV_M3_FEE_ADDRESS;

test.describe("M3: proving a sweep in the browser", () => {
  test.skip(
    !FRAGMENT || !DESTINATION || !FEE_ADDRESS,
    "ZENV_M1_FRAGMENT, ZENV_M3_DEST_ADDRESS and ZENV_M3_FEE_ADDRESS must all be set",
  );

  // Building the proving key and then proving is minutes of single-threaded wasm.
  test.setTimeout(600_000);

  test("warms the proving key and proves a 2-action Ironwood sweep", async ({ page }) => {
    const { secret } = parseFragment(FRAGMENT!);
    expect(secret, "fragment secret is 43 base64url chars").toMatch(/^[A-Za-z0-9_-]{43}$/);

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    // The production build really is served cross-origin isolated...
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    expect(res!.headers()["cross-origin-opener-policy"]).toBe("same-origin");
    expect(res!.headers()["cross-origin-embedder-policy"]).toBe("require-corp");

    // ...and the sweep then runs on a page of its own, with the same headers.
    await openHarness(page);

    const started = Date.now();
    const raw = await page.evaluate(
      async ([url, secretArg, lwd, destination, feeAddress, noteJson, feeZat]) => {
        const core: any = await import(/* @vite-ignore */ (url as string));
        await core.default();

        // The destination must classify as payable before a single byte is fetched.
        const verdict = core.classify_address(destination as string, "main");

        const warmMs: number = await core.warm_proving_key();
        // A second call must be nearly free: the key is cached for the whole page.
        const secondWarmMs: number = await core.warm_proving_key();

        const stages: Array<[string, string]> = [];
        const onStage = (stage: string, detail: string) => {
          stages.push([stage, detail]);
        };

        const sweepStarted = Date.now();
        const result = await core.sweep_envelope(
          secretArg as string,
          "main",
          lwd as string,
          JSON.parse(noteJson as string),
          destination as string,
          feeAddress as string,
          feeZat as string,
          "Zenvelope M3",
          false, // broadcast: never, from a test
          onStage,
        );
        const sweepMs = Date.now() - sweepStarted;

        return JSON.stringify({
          verdict: { kind: verdict.kind, reason: verdict.reason },
          warmMs,
          secondWarmMs,
          sweepMs,
          stages,
          result,
        });
      },
      [
        glueUrl(),
        secret,
        LIGHTWALLETD,
        DESTINATION!,
        FEE_ADDRESS!,
        JSON.stringify(NOTE),
        String(FEE_ZAT),
      ] as const,
    );
    const totalSeconds = (Date.now() - started) / 1000;

    const { verdict, warmMs, secondWarmMs, sweepMs, stages, result } = JSON.parse(raw) as {
      verdict: { kind: string; reason: string | null };
      warmMs: number;
      secondWarmMs: number;
      sweepMs: number;
      stages: Array<[string, string]>;
      result: SweepResult;
    };

    expect(errors, `page errors: ${errors.join("; ")}`).toHaveLength(0);

    const rawBytes = result.raw_tx_hex ? result.raw_tx_hex.length / 2 : 0;
    console.log(
      `M3 browser sweep: proving key ${(warmMs / 1000).toFixed(1)} s ` +
        `(second call ${secondWarmMs.toFixed(0)} ms), sweep ${(sweepMs / 1000).toFixed(1)} s, ` +
        `total ${totalSeconds.toFixed(1)} s, raw tx ${rawBytes} bytes, ` +
        `anchor ${result.anchor_height}, txid ${result.txid}`,
    );
    console.log(`M3 stages: ${stages.map(([s]) => s).join(" -> ")}`);

    // --- the destination is payable ---------------------------------------
    expect(verdict.kind).toBe("unified_orchard");
    // wasm-bindgen sends a None as `undefined`, which JSON.stringify then drops.
    expect(verdict.reason ?? null).toBeNull();

    // --- the proving key was really built, and really cached --------------
    expect(warmMs).toBeGreaterThan(1_000);
    expect(secondWarmMs).toBeLessThan(warmMs / 10);

    // --- the stages fired in order ----------------------------------------
    const order = stages.map(([stage]) => stage);
    const firstSeen = ["witness", "keys", "proving", "broadcast", "done"].map((s) =>
      order.indexOf(s),
    );
    expect(firstSeen.every((i) => i >= 0), `stages: ${order.join(", ")}`).toBe(true);
    for (let i = 1; i < firstSeen.length; i++) {
      expect(firstSeen[i], `stage order: ${order.join(", ")}`).toBeGreaterThan(
        firstSeen[i - 1],
      );
    }
    expect(order[order.length - 1]).toBe("done");

    // --- a real transaction came back -------------------------------------
    expect(result.raw_tx_hex).not.toBeNull();
    expect(result.raw_tx_hex).toMatch(/^[0-9a-f]+$/);
    expect(rawBytes).toBeGreaterThan(5_000); // a proved Ironwood bundle is not small
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/);
    // A V6 transaction starts with the header 0x800000060 little-endian... in practice
    // the shape is pinned by the native test, which parses the bytes back; here it is
    // enough that the body is a long, well-formed hex string with a matching txid.

    // --- the amounts ------------------------------------------------------
    expect(result.amount_to_destination_zat).toBe(
      String(NOTE_VALUE_ZAT - NETWORK_FEE_ZAT - FEE_ZAT),
    );
    expect(result.fee_zat).toBe(String(FEE_ZAT));
    expect(result.network_fee_zat).toBe(String(NETWORK_FEE_ZAT));

    // --- nothing was sent -------------------------------------------------
    expect(result.broadcast).toBe(false);
    expect(result.error_code).toBeNull();
    expect(result.error_message).toBeNull();

    // --- the anchor is a real height at or after the note's block ---------
    expect(result.anchor_height).toBeGreaterThanOrEqual(NOTE.height);
  });

  test("refuses a Sapling destination before touching the network", async ({ page }) => {
    await openHarness(page);
    const out = await page.evaluate(
      async ([url]) => {
        const core: any = await import(/* @vite-ignore */ (url as string));
        await core.default();
        // A well-formed mainnet Sapling address: the all-zero payload, as encoded by
        // zcash_address itself (see crates/core TEST_VECTORS.md, print_m3_test_vectors).
        const zs =
          "zs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpq6d8g";
        const verdict = core.classify_address(zs, "main");
        return JSON.stringify({ kind: verdict.kind, reason: verdict.reason });
      },
      [glueUrl()] as const,
    );
    const { kind, reason } = JSON.parse(out) as { kind: string; reason: string | null };
    expect(kind).toBe("sapling");
    expect(reason).toContain("Sapling");
  });

  test("generates a wallet a recipient can import", async ({ page }) => {
    await openHarness(page);
    const out = await page.evaluate(
      async ([url]) => {
        const core: any = await import(/* @vite-ignore */ (url as string));
        await core.default();
        const a = core.new_wallet("main", 3_490_472);
        const b = core.new_wallet("main", 3_490_472);
        const verdict = core.classify_address(a.address, "main");
        return JSON.stringify({
          words: a.mnemonic.split(" ").length,
          addressA: a.address,
          addressB: b.address,
          ufvkPrefix: a.ufvk.slice(0, 6),
          birthday: a.birthday,
          kind: verdict.kind,
        });
      },
      [glueUrl()] as const,
    );
    const w = JSON.parse(out) as {
      words: number;
      addressA: string;
      addressB: string;
      ufvkPrefix: string;
      birthday: number;
      kind: string;
    };
    expect(w.words).toBe(24);
    expect(w.addressA).toMatch(/^u1/);
    expect(w.addressA).not.toBe(w.addressB);
    expect(w.ufvkPrefix).toBe("uview1");
    expect(w.birthday).toBe(3_490_472);
    expect(w.kind).toBe("unified_orchard");
  });
});
