/**
 * M3 end-to-end proof: the real UI, the real wasm core, the real mainnet envelope —
 * built and proved, and deliberately never sent.
 *
 *   ./scripts/build-core.sh
 *   cd web && npm ci
 *   ZENV_M1_FRAGMENT='<secret>.<birthday>' \
 *   ZENV_M3_DEST_ADDRESS='u1…' \
 *   ZENV_EXPECT_ZEC='0.0003' \
 *     npm run build && \
 *   ZENV_M1_FRAGMENT='<secret>.<birthday>' \
 *   ZENV_M3_DEST_ADDRESS='u1…' \
 *   ZENV_EXPECT_ZEC='0.0003' \
 *     npx playwright test e2e/m3-real.spec.ts
 *
 * **Which envelope.** The M1 envelope (0.0013 ZEC) was swept on 2026-09-21 and is
 * empty. The live fixture is now the **fee envelope** from M3-DEST.md, which holds
 * 0.0003 ZEC and is unspent, so `ZENV_EXPECT_ZEC` says what this run should find and
 * every figure below is derived from it. It defaults to the M1 amount, so a run
 * against a refilled envelope needs nothing new.
 *
 * `VITE_FEE_ADDRESS` is optional and has to be set for the **build** when it is set at
 * all, because that is when Vite bakes it into config.ts; it is read here only to know
 * whether to expect the fee line. It cannot be used with the fee envelope itself —
 * 30,000 zatoshi cannot pay a 30,000 zatoshi fee and a miner fee — so the arithmetic
 * below drops that line when the build had no fee address, and the group skips when
 * the envelope cannot cover its fees at all. Every value lives in the private,
 * gitignored M1-FUND.md and M3-DEST.md, is read from the environment, and the group
 * skips cleanly when one is missing — which is what CI and a fresh checkout see.
 *
 * Where e2e/m3-core.spec.ts drives the wasm exports directly from a bare page, this
 * drives the **product**: the /e page, the open flow, the destination picker, the
 * review screen and the four-stage progress screen, on the real core.
 *
 * What it proves:
 *   - the real wasm is loaded: no MOCK badge anywhere
 *   - the envelope opens on mainnet and reveals ZENV_EXPECT_ZEC
 *   - the link secret is out of the URL bar before anything else happens (H1)
 *   - warm_proving_key finishes in the background and the page says "Keys ready"
 *   - a pasted unified address is accepted and the review arithmetic is right,
 *     including the flat Zenvelope fee on its own output
 *   - the four stages run in order and the sweep is really built and proved
 *   - **M4**: all four stages are visibly PAINTED, and the elapsed clock keeps ticking
 *     while the proof runs — the core is in a worker now, so the page has nothing to do
 *     during a proof but render (M4-VERIFICATION.md; the M3 finding this replaces is in
 *     M3-VERIFICATION.md §4)
 *   - the new-wallet path generates a wallet and sweeps to it just the same
 *
 * It NEVER broadcasts. The page is loaded with `?dry=1`, which makes SendOn pass
 * `broadcast: false`; the done screen's own `raw_tx_hex` and the "Dry run" copy are
 * asserted on the way out, so a run that silently broadcast would fail here.
 * Broadcasting the real sweep is a separate step, triggered by hand.
 *
 * Screenshots: docs/m3-review-real.png, docs/m3-done-dry.png.
 */

import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(HERE, "../docs");

const FRAGMENT = process.env.ZENV_M1_FRAGMENT;
const DESTINATION = process.env.ZENV_M3_DEST_ADDRESS;
const FEE_ADDRESS = process.env.VITE_FEE_ADDRESS;
const FEE_ENABLED = (FEE_ADDRESS ?? "").trim() !== "";

/**
 * M4: cap the proving pool, so the same build gives both rows of the timing table.
 * `ZENV_M4_THREADS=1` sends the core worker down the single-threaded package.
 */
const THREADS = process.env.ZENV_M4_THREADS;
const QUERY = `?dry=1${THREADS ? `&threads=${THREADS}` : ""}`;

/* ------------------------------------------------------- what to expect, in ZEC */

/** Zatoshi from a ZEC string: "0.0003" -> 30000n. */
function toZat(zec: string): bigint {
  const [whole, frac = ""] = zec.trim().split(".");
  return BigInt(whole || "0") * 100_000_000n + BigInt((frac + "00000000").slice(0, 8));
}

/** The same string the page renders, from src/lib/format.ts. */
function asZec(zat: bigint): string {
  const whole = (zat / 100_000_000n).toString();
  const frac = (zat % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole}.${frac === "" ? "0" : frac} ZEC`;
}

/**
 * What the envelope under test holds. The M1 envelope was swept and is empty, so
 * the live fixture is the 0.0003 ZEC fee envelope; the default is kept at the M1
 * amount so nothing about this file assumes today's fixture forever.
 */
const ENVELOPE_ZAT = toZat(process.env.ZENV_EXPECT_ZEC ?? "0.0013");
/** ZIP-317 for a shielded destination, which both destinations here are. */
const NETWORK_FEE_ZAT = 10_000n;
/** The flat Zenvelope fee, when the build had an address to send it to (D13). */
const SERVICE_FEE_ZAT = FEE_ENABLED ? 30_000n : 0n;
const RECEIVE_ZAT = ENVELOPE_ZAT - NETWORK_FEE_ZAT - SERVICE_FEE_ZAT;

const ENVELOPE = asZec(ENVELOPE_ZAT);
const NETWORK_FEE = asZec(NETWORK_FEE_ZAT);
const SERVICE_FEE = asZec(SERVICE_FEE_ZAT);
const RECEIVE = asZec(RECEIVE_ZAT);

/**
 * The proved bundle: 9,166 bytes for the two-output M1 sweep, measured natively and
 * in the browser. A one-output sweep is smaller, so the floor is generous — the
 * point of the check is that a real proved transaction was built, not its exact size.
 */
const TX_BYTES_MIN = 5_000;
const TX_BYTES_MAX = 12_000;

/** One stage row's state, with the millisecond it reached it. */
interface StageEvent {
  stage: string;
  state: string;
  at: number;
}

/**
 * Records every change of a stage row's `data-state`, in the page, with a timestamp.
 *
 * Reading the rows from the test would mean a round trip per poll and would miss a
 * stage that starts and ends between two of them. A MutationObserver sees every one.
 */
async function watchStages(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: Array<{ stage: string; state: string; at: number }> = [];
    const t0 = Date.now();
    Object.assign(window, { __stageLog: log });

    const sample = () => {
      for (const el of Array.from(document.querySelectorAll('[data-testid="stage-row"]'))) {
        const stage = el.getAttribute("data-stage") ?? "";
        const state = el.getAttribute("data-state") ?? "";
        let last: { stage: string; state: string; at: number } | undefined;
        for (const e of log) if (e.stage === stage) last = e;
        if (!last || last.state !== state) log.push({ stage, state, at: Date.now() - t0 });
      }
    };

    new MutationObserver(sample).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });
    sample();
  });
}

async function readStages(page: Page): Promise<StageEvent[]> {
  return page.evaluate(
    () => (window as unknown as { __stageLog?: StageEvent[] }).__stageLog ?? [],
  );
}

/**
 * How long each stage was the active one: the gap between it going active and the
 * next one doing so, and for the last one, the moment the done screen replaced it.
 */
function stageDurations(events: StageEvent[], endedAt: number): Array<[string, number]> {
  const actives = events.filter((e) => e.state === "active");
  return actives.map((e, i) => {
    const next = i + 1 < actives.length ? actives[i + 1].at : endedAt;
    return [e.stage, next - e.at] as [string, number];
  });
}

/** Opens the real envelope and waits for the reveal. */
async function openEnvelope(page: Page): Promise<void> {
  await page.goto(`/e${QUERY}#${FRAGMENT}`);
  // H1: the money's own link is out of the address bar before anything else.
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 60_000 })
    .toBe("");
  expect(page.url()).not.toContain(FRAGMENT!.split(".")[0]);
  // The real core is in this build: a MOCK badge here would mean the wasm is missing
  // and every number below would be invented.
  await expect(page.getByTestId("mock-badge")).toHaveCount(0);
  // Which wasm package the worker chose, so every timing below is attributable.
  console.log(`M4 ${await page.getByTestId("proving-note").innerText()}`);
  await page.getByTestId("open-envelope").click();
  await expect(page.getByTestId("amount")).toHaveText(ENVELOPE, { timeout: 180_000 });
  await expect(page.getByTestId("mock-badge")).toHaveCount(0);
  // warm_proving_key runs in the background from the moment the envelope opens. This is
  // the wait a recipient actually has before "Send it on" can start proving, so it is
  // the other half of the M4 timing table.
  const openedAt = Date.now();
  await expect(page.getByTestId("warm-status")).toHaveText("Keys ready", { timeout: 300_000 });
  console.log(`M4 proving key warm: ${((Date.now() - openedAt) / 1000).toFixed(1)} s`);
}

/** Checks the review numbers, then runs the sweep and asserts the dry-run screen. */
async function sweepAndAssert(page: Page, label: string, screenshot?: string): Promise<number> {
  await expect(page.getByTestId("review-in-envelope")).toHaveText(ENVELOPE);
  await expect(page.getByTestId("review-network-fee")).toHaveText(NETWORK_FEE);
  if (FEE_ENABLED) {
    await expect(page.getByTestId("review-service-fee")).toHaveText(SERVICE_FEE);
  } else {
    // No fee address in this build, so no fee output and no line for it (D13).
    await expect(page.getByTestId("review-service-fee")).toHaveCount(0);
  }
  await expect(page.getByTestId("review-receive")).toHaveText(RECEIVE);
  if (screenshot) {
    mkdirSync(DOCS, { recursive: true });
    await page.screenshot({ path: resolve(DOCS, screenshot), fullPage: true });
  }

  await watchStages(page);
  const tapped = Date.now();
  await page.getByTestId("send-it-on").click();
  await expect(page.getByTestId("sending")).toBeVisible();
  await expect(page.getByTestId("stage-row")).toHaveCount(4);

  // --- M4: the page stays alive through the proof --------------------------
  //
  // In M3 this was impossible. The prover ran on the page's main thread with no `await`
  // between "keys", "proving" and the 42 s of halo2 that followed, so no render could be
  // scheduled: the checklist froze on `witness` and the elapsed clock stopped. The core
  // now runs in a Web Worker, so the only claim worth making is the recipient's own —
  // that they can SEE the proving stage, and that the clock is still moving while it runs.
  const provingRow = page.locator('[data-testid="stage-row"][data-stage="proving"]');
  await expect(provingRow).toHaveAttribute("data-state", "active", { timeout: 300_000 });
  await expect(provingRow).toBeVisible();
  // The two stages before it must already be ticked off on screen, not just reported.
  await expect(page.locator('[data-testid="stage-row"][data-stage="witness"]')).toHaveAttribute(
    "data-state",
    "done",
  );
  await expect(page.locator('[data-testid="stage-row"][data-stage="keys"]')).toHaveAttribute(
    "data-state",
    "done",
  );

  // The clock, read twice across a real wall-clock gap, mid-proof. A frozen main thread
  // cannot fire the 250 ms interval that drives it, so this is the freeze test.
  const first = await page.getByTestId("elapsed").innerText();
  await page.waitForTimeout(3_000);
  const second = await page.getByTestId("elapsed").innerText();
  // Still proving when the second reading was taken: otherwise this measured nothing.
  await expect(provingRow).toHaveAttribute("data-state", "active");
  const seconds = (t: string) => {
    const [m, s] = t.split(":");
    return Number(m) * 60 + Number(s);
  };
  console.log(`M3 real dry run (${label}): elapsed ${first} -> ${second} while proving`);
  expect(
    seconds(second),
    `the elapsed clock did not advance during proving: ${first} -> ${second}`,
  ).toBeGreaterThan(seconds(first));

  await expect(page.getByTestId("sent-heading")).toBeVisible({ timeout: 600_000 });
  const totalMs = Date.now() - tapped;
  const events = await readStages(page);

  // --- every stage was painted, in the documented order --------------------
  //
  // M3 could only assert that `witness` was painted (see the note above). With the core
  // in a worker, all four have to be: a missing row here means the page went blind
  // again, which is the regression this milestone exists to prevent.
  const activeOrder = events.filter((e) => e.state === "active").map((e) => e.stage);
  // The three that do real work must all be painted, in order. `broadcast` is the one
  // that may not be: on a dry run it is skipped, so the core reports it and `done` back
  // to back and React coalesces both into the render that shows the done screen. That is
  // the stage being instant, not the page being frozen, which is what the three above it
  // and the ticking clock already rule out.
  expect(activeOrder.slice(0, 3), `stage order: ${activeOrder.join(", ")}`).toEqual([
    "witness",
    "keys",
    "proving",
  ]);
  const expected = ["witness", "keys", "proving", "broadcast"];
  expect(activeOrder, `stage order: ${activeOrder.join(", ")}`).toEqual(
    expected.filter((s) => activeOrder.includes(s)),
  );

  const durations = stageDurations(events, totalMs);
  console.log(
    `M3 real dry run (${label}): tap to Done ${(totalMs / 1000).toFixed(1)} s — ` +
      `painted ${durations.map(([s, ms]) => `${s} ${(ms / 1000).toFixed(1)} s`).join(", ")}`,
  );

  // The Done screen's own Timing block, which is what a perf report is made of:
  // it carries open/scan and the gateway the core raced and won with, neither of
  // which the stage log above can know.
  console.log(
    `M3 real dry run (${label}): open/scan ${await page
      .getByTestId("timing-open")
      .innerText()}, witness ${await page
      .getByTestId("timing-witness")
      .innerText()} — ${await page.getByTestId("timing-device").innerText()}`,
  );

  // --- the done screen is a DRY RUN, and says so ---------------------------
  await expect(page.getByTestId("sent-heading")).toHaveText("Dry run complete.");
  await expect(page.getByTestId("dry-run-note")).toHaveText(
    "Dry run: transaction built and proved, not sent",
  );
  await expect(page.getByTestId("sent-amount")).toHaveText(RECEIVE);
  await expect(page.getByTestId("sent-txid")).toHaveText(/^[0-9a-f]{10}…[0-9a-f]{10}$/);
  // Nothing moved, so there is nothing to look up and the envelope is not empty.
  await expect(page.getByTestId("explorer-link")).toHaveCount(0);
  await expect(page.getByTestId("envelope-empty")).toHaveCount(0);
  await expect(page.getByTestId("envelope-intact")).toContainText("Nothing was sent");

  // --- a real, proved transaction was built --------------------------------
  const sizeText = await page.getByTestId("dry-run-size").innerText();
  const bytes = Number(sizeText.replace(/[^\d]/g, ""));
  console.log(`M3 real dry run (${label}): raw transaction ${bytes} bytes`);
  expect(bytes).toBeGreaterThan(TX_BYTES_MIN);
  expect(bytes).toBeLessThan(TX_BYTES_MAX);

  // Nothing on any screen may say "claim": it is the top wallet-drainer lure.
  expect((await page.locator("body").innerText()).toLowerCase()).not.toContain("claim");
  return bytes;
}

test.describe("M3: a real mainnet sweep through the UI, dry run", () => {
  test.skip(
    !FRAGMENT || !DESTINATION,
    "ZENV_M1_FRAGMENT and ZENV_M3_DEST_ADDRESS must both be set. VITE_FEE_ADDRESS is " +
      "optional, and when it is set it must have been set for `npm run build` too",
  );
  test.skip(
    RECEIVE_ZAT <= 0n,
    `the envelope (${ENVELOPE}) cannot cover its fees; set ZENV_EXPECT_ZEC, or run ` +
      "without VITE_FEE_ADDRESS",
  );

  // The proving key and the proof are minutes of single-threaded wasm each.
  test.setTimeout(1_200_000);

  test("pastes a Zcash address, reviews, sends, and lands on the dry-run screen", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    // The secret is in the fragment, which is never sent: prove it.
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));

    await openEnvelope(page);

    await page.getByTestId("dest-address").click();
    await page.getByTestId("dest-input").fill(DESTINATION!);
    await expect(page.getByTestId("dest-feedback")).toHaveAttribute("data-status", "ok");
    await expect(page.getByTestId("to-review")).toBeEnabled();
    await page.getByTestId("to-review").click();

    await sweepAndAssert(page, "pasted address", "m3-review-real.png");
    mkdirSync(DOCS, { recursive: true });
    await page.screenshot({ path: resolve(DOCS, "m3-done-dry.png"), fullPage: true });

    expect(errors, `page errors: ${errors.join("; ")}`).toHaveLength(0);
    const secret = FRAGMENT!.split(".")[0];
    for (const url of requests) expect(url).not.toContain(secret);
    const stored = await page.evaluate(() => [
      JSON.stringify(window.localStorage),
      JSON.stringify(window.sessionStorage),
    ]);
    expect(stored).toEqual(["{}", "{}"]);
  });

  test("generates a wallet in the browser and sweeps to it, dry run", async ({ page, context }) => {
    // So the generated address can be read back in full: the screen truncates it.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});

    await openEnvelope(page);

    await page.getByTestId("dest-wallet").click();
    await expect(page.getByTestId("wallet-word")).toHaveCount(24);
    await expect(page.getByTestId("wallet-birthday")).not.toBeEmpty();

    // The whole address, off the clipboard. The words are never read: the mnemonic
    // is the money and it stays on the screen.
    const field = page.locator(".copy-field").filter({ has: page.getByTestId("wallet-address") });
    await field.getByRole("button", { name: "Copy" }).click();
    const address = await page
      .evaluate(() => navigator.clipboard.readText())
      .catch(() => "<clipboard unavailable>");
    console.log(`M3 new wallet address: ${address}`);
    expect(address.startsWith("u1"), `wallet address: ${address}`).toBe(true);

    // The gate: the words have to be written down before there is a way forward.
    await expect(page.getByTestId("to-review")).toBeDisabled();
    await page.getByTestId("wallet-confirm").check();
    await expect(page.getByTestId("to-review")).toBeEnabled();
    await page.getByTestId("to-review").click();

    await sweepAndAssert(page, "new wallet");

    // The mnemonic left no trace anywhere it could be read back.
    const stored = await page.evaluate(() => [
      JSON.stringify(window.localStorage),
      JSON.stringify(window.sessionStorage),
    ]);
    expect(stored).toEqual(["{}", "{}"]);
  });
});
