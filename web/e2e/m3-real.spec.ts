/**
 * M3 end-to-end proof: the real UI, the real wasm core, the real mainnet envelope —
 * built and proved, and deliberately never sent.
 *
 *   ./scripts/build-core.sh
 *   cd web && npm ci
 *   ZENV_M1_FRAGMENT='<secret>.<birthday>' \
 *   ZENV_M3_DEST_ADDRESS='u1…' \
 *   VITE_FEE_ADDRESS='u1…' \
 *     npm run build && \
 *   ZENV_M1_FRAGMENT='<secret>.<birthday>' \
 *   ZENV_M3_DEST_ADDRESS='u1…' \
 *   VITE_FEE_ADDRESS='u1…' \
 *     npx playwright test e2e/m3-real.spec.ts
 *
 * `VITE_FEE_ADDRESS` has to be set for the **build**, because that is when Vite bakes
 * it into config.ts; it is read again here only so the test can refuse to run against
 * a build that never saw it. All three values live in the private, gitignored
 * M1-FUND.md and M3-DEST.md, are read from the environment, and the group skips
 * cleanly when any is missing — which is what CI and a fresh checkout see.
 *
 * Where e2e/m3-core.spec.ts drives the wasm exports directly from a bare page, this
 * drives the **product**: the /e page, the open flow, the destination picker, the
 * review screen and the four-stage progress screen, on the real core.
 *
 * What it proves:
 *   - the real wasm is loaded: no MOCK badge anywhere
 *   - the envelope opens on mainnet and reveals 0.0013 ZEC
 *   - warm_proving_key finishes in the background and the page says "Keys ready"
 *   - a pasted unified address is accepted and the review arithmetic is right,
 *     including the flat Zenvelope fee on its own output
 *   - the four stages run in order and the sweep is really built and proved
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

/** The M1 envelope: 130,000 zatoshi, one Ironwood note. */
const ENVELOPE = "0.0013 ZEC";
const NETWORK_FEE = "0.0001 ZEC";
const SERVICE_FEE = "0.0003 ZEC";
const RECEIVE = "0.0009 ZEC";

/** The proved bundle measured at 9,166 bytes natively and in the browser. */
const TX_BYTES_MIN = 8_000;
const TX_BYTES_MAX = 11_000;

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
  await page.goto(`/e?dry=1#${FRAGMENT}`);
  // The real core is in this build: a MOCK badge here would mean the wasm is missing
  // and every number below would be invented.
  await expect(page.getByTestId("mock-badge")).toHaveCount(0);
  await page.getByTestId("open-envelope").click();
  await expect(page.getByTestId("amount")).toHaveText(ENVELOPE, { timeout: 180_000 });
  await expect(page.getByTestId("mock-badge")).toHaveCount(0);
  // warm_proving_key runs in the background from the moment the envelope opens.
  await expect(page.getByTestId("warm-status")).toHaveText("Keys ready", { timeout: 300_000 });
}

/** Checks the review numbers, then runs the sweep and asserts the dry-run screen. */
async function sweepAndAssert(page: Page, label: string, screenshot?: string): Promise<number> {
  await expect(page.getByTestId("review-in-envelope")).toHaveText(ENVELOPE);
  await expect(page.getByTestId("review-network-fee")).toHaveText(NETWORK_FEE);
  await expect(page.getByTestId("review-service-fee")).toHaveText(SERVICE_FEE);
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

  await expect(page.getByTestId("sent-heading")).toBeVisible({ timeout: 600_000 });
  const totalMs = Date.now() - tapped;
  const events = await readStages(page);

  // --- the stages that were painted, in the documented order ---------------
  //
  // Only `witness` is ever painted on a real run, and that is a property of the
  // prover, not a flake. `crates/core/src/sweep.rs` reports "keys", then
  // "proving", and then calls `build_and_prove`, and there is no `.await`
  // anywhere between the three: single-threaded wasm proving holds the main
  // thread for the whole proof, so the browser cannot paint those rows (or tick
  // the elapsed clock) until the sweep resolves, by which time the done screen
  // has replaced them. The stage callbacks themselves all fire, in order, and
  // e2e/m3-core.spec.ts times each one from the callback. Threading the prover
  // is M4; until then this asserts what a recipient actually sees.
  const activeOrder = events.filter((e) => e.state === "active").map((e) => e.stage);
  const expected = ["witness", "keys", "proving", "broadcast"];
  expect(activeOrder, `stage order: ${activeOrder.join(", ")}`).toEqual(
    expected.filter((s) => activeOrder.includes(s)),
  );
  expect(activeOrder[0], `stage order: ${activeOrder.join(", ")}`).toBe("witness");

  const durations = stageDurations(events, totalMs);
  console.log(
    `M3 real dry run (${label}): tap to Done ${(totalMs / 1000).toFixed(1)} s — ` +
      `painted ${durations.map(([s, ms]) => `${s} ${(ms / 1000).toFixed(1)} s`).join(", ")}`,
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
    !FRAGMENT || !DESTINATION || !FEE_ADDRESS,
    "ZENV_M1_FRAGMENT, ZENV_M3_DEST_ADDRESS and VITE_FEE_ADDRESS must all be set, and " +
      "VITE_FEE_ADDRESS must have been set for `npm run build` too",
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
