/**
 * M2 end-to-end proof: a browser opens a funded mainnet envelope.
 *
 *   ZENV_M1_FRAGMENT='<secret>.<birthday>' npm run e2e
 *
 * The fragment is the money, so it is never committed and never printed. It is read
 * from the environment at run time and the test skips cleanly when it is absent, which
 * is what CI and a fresh checkout see.
 *
 * What it proves:
 *   - the built wasm derives the viewing key, syncs compact blocks from the birthday to
 *     the chain tip over gRPC-web, and trial-decrypts the note, all inside the page
 *   - the note it finds is the IRONWOOD note the zcash-devtool oracle sees: the amount,
 *     the memo, the height, the txid and the pool all match
 *   - progress callbacks fire during the scan
 *
 * The scan wall time and the block count are printed, because they are the numbers the
 * open flow is budgeted against.
 */

import { expect, test } from "@playwright/test";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_ASSETS = resolve(HERE, "../dist/assets");

const LIGHTWALLETD = "https://zjs.zec.rocks/mainnet";

/**
 * The note the zcash-devtool oracle sees for the M1 envelope. See M1-FUND.md (private).
 *
 * `memo` is null, not "Zenvelope M1": that string was the ZIP-321 `message` parameter in
 * the payment URI, and the sending wallet kept it as a local label rather than writing it
 * into the note. The oracle agrees — `list-tx` prints "received 1 notes, 0 memos" and
 * `Memo: Memo::Empty` — so an empty memo is the correct answer here, and asserting it
 * keeps the test honest about what a ZIP-321 message does and does not carry.
 *
 * That finding is what moved the create flow onto the ZIP-321 `memo=` parameter, which
 * the sending wallet does write into the note: see web/docs/M2-VERIFICATION.md §4. The
 * M1 envelope cannot be re-funded, so this vector stays as it is.
 */
const ORACLE = {
  amount_zat: "130000",
  memo: null as string | null,
  height: 3_490_472,
  txid: "281e9f7bffa5bffc8ee1287cc6e245cc59eee302727ea9d93c7f8e5a99341d43",
  pool: "ironwood",
};

interface OpenedNote {
  amount_zat: string;
  memo: string | null;
  height: number;
  txid: string;
  pool: string;
}

interface Opened {
  found: boolean;
  notes: OpenedNote[];
  total_zat: string;
  tip_height: number;
  birthday: number;
  birthday_defaulted: boolean;
  scanned_blocks: number;
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
 * importer in the page then races that init, and the renderer dies. So the scan gets a
 * page of its own, served by request interception with the production isolation headers.
 */
const HARNESS_PATH = "/__m2-core-harness";

async function openHarness(page: import("@playwright/test").Page) {
  await page.route(`**${HARNESS_PATH}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: {
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
      },
      body: "<!doctype html><meta charset=utf-8><title>m2 harness</title>",
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

test.describe("M2: opening a funded envelope in the browser", () => {
  test.skip(
    !FRAGMENT,
    "ZENV_M1_FRAGMENT is not set; this test needs the funded M1 link secret",
  );

  // A cold scan talks to mainnet over the public gRPC-web gateway.
  test.setTimeout(180_000);

  test("finds the Ironwood note the oracle sees", async ({ page }) => {
    const { secret, birthday } = parseFragment(FRAGMENT!);
    expect(secret, "fragment secret is 43 base64url chars").toMatch(/^[A-Za-z0-9_-]{43}$/);

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    // The production build really is served cross-origin isolated...
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    expect(res!.headers()["cross-origin-opener-policy"]).toBe("same-origin");
    expect(res!.headers()["cross-origin-embedder-policy"]).toBe("require-corp");

    // ...and the scan then runs on a page of its own, with the same headers.
    await openHarness(page);

    // The page hands back JSON rather than the live result object, so nothing backed by
    // wasm memory has to survive a structured clone out of the renderer.
    const started = Date.now();
    const raw = await page.evaluate(
      async ([url, secretArg, birthdayArg, lwd]) => {
        const core: any = await import(/* @vite-ignore */ url as string);
        await core.default();

        const seen: Array<[number, number]> = [];
        const onProgress = (scanned: number, total: number) => {
          seen.push([scanned, total]);
        };

        const result = await core.open_envelope(
          secretArg as string,
          birthdayArg as number | undefined,
          "main",
          lwd as string,
          onProgress,
        );

        return JSON.stringify({
          result,
          progress: seen.length,
          lastProgress: seen.length ? seen[seen.length - 1] : null,
        });
      },
      [glueUrl(), secret, birthday, LIGHTWALLETD] as const,
    );
    const seconds = (Date.now() - started) / 1000;
    const { result, progress, lastProgress } = JSON.parse(raw) as {
      result: Opened;
      progress: number;
      lastProgress: [number, number] | null;
    };

    expect(errors, `page errors: ${errors.join("; ")}`).toHaveLength(0);

    console.log(
      `M2 scan: ${result.scanned_blocks} blocks (${result.birthday}..${result.tip_height}) ` +
        `in ${seconds.toFixed(1)} s, ${progress} progress callbacks, ` +
        `last ${JSON.stringify(lastProgress)}`,
    );

    expect(result.found).toBe(true);
    expect(result.notes).toHaveLength(1);

    const note = result.notes[0];
    expect(note.amount_zat).toBe(ORACLE.amount_zat);
    expect(note.memo).toBe(ORACLE.memo);
    expect(note.height).toBe(ORACLE.height);
    expect(note.txid).toBe(ORACLE.txid);
    expect(note.pool).toBe(ORACLE.pool);

    expect(result.total_zat).toBe(ORACLE.amount_zat);
    expect(result.birthday).toBe(birthday);
    expect(result.birthday_defaulted).toBe(false);
    expect(result.tip_height).toBeGreaterThanOrEqual(ORACLE.height);
    expect(result.scanned_blocks).toBe(result.tip_height - result.birthday + 1);

    // Progress fired, and the last report covers the whole range.
    expect(progress).toBeGreaterThan(0);
    expect(lastProgress).not.toBeNull();
    expect(lastProgress![0]).toBe(result.scanned_blocks);
    expect(lastProgress![1]).toBe(result.scanned_blocks);
  });

  test("rejects a malformed secret without touching the network", async ({ page }) => {
    await openHarness(page);
    const message = await page.evaluate(
      async ([url, lwd]) => {
        const core: any = await import(/* @vite-ignore */ url as string);
        await core.default();
        try {
          await core.open_envelope("too-short", undefined, "main", lwd as string, undefined);
          return "no error";
        } catch (e) {
          return String(e);
        }
      },
      [glueUrl(), LIGHTWALLETD] as const,
    );
    expect(message).toContain("43 base64url characters");
  });
});
