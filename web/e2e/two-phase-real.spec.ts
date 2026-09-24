/**
 * Two-phase open on mainnet: the fee envelope from its final link and from its
 * original link, timed to the reveal and to the end of the spend check.
 *
 *   ./scripts/build-core.sh && cd web && npm run build
 *   ZENV_FEE_FRAGMENT='<secret>.<birthday>' ZENV_FEE_PAID_HEIGHT=3491056 \
 *   ZENVELOPE_E2E_PORT=4281 npx playwright test e2e/two-phase-real.spec.ts
 *
 * The fragment is the fee envelope's, from the private, gitignored M3-DEST.md,
 * read from the environment at run time; the group skips when it is missing.
 * `?dry=1`, and the envelope (0.0003 ZEC) is under the service-fee floor, so the
 * page ends on "too small to send on": nothing is built, proved or broadcast.
 *
 * Reveal: tap on "Open envelope" to the amount on screen. Check complete: tap to
 * the send-on area replacing the "Checking…" card (here, the too-small line).
 */

import { expect, test, type Page } from "@playwright/test";

const FRAGMENT = process.env.ZENV_FEE_FRAGMENT;
const PAID_HEIGHT = Number(process.env.ZENV_FEE_PAID_HEIGHT ?? "0");
const EXPECT_ZEC = process.env.ZENV_EXPECT_ZEC ?? "0.0003";
const RUNS = Number(process.env.ZENV_TWO_PHASE_RUNS ?? "3");

const describeReal = FRAGMENT && PAID_HEIGHT > 0 ? test.describe : test.describe.skip;

async function timeOpen(
  page: Page,
  fragment: string,
): Promise<{ revealMs: number; doneMs: number; span: string }> {
  await page.goto("about:blank");
  await page.goto(`/e?dry=1#${fragment}`);
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 60_000 })
    .toBe("");
  await expect(page.getByTestId("mock-badge")).toHaveCount(0);
  const button = page.getByTestId("open-envelope");
  await expect(button).toBeEnabled({ timeout: 60_000 });

  const t0 = Date.now();
  await button.click();
  const amount = page.getByTestId("amount");
  while (!(await amount.isVisible())) {
    if (Date.now() - t0 > 240_000) throw new Error("no reveal in 4 minutes");
    await page.waitForTimeout(25);
  }
  const revealMs = Date.now() - t0;
  await expect(amount).toContainText(`${EXPECT_ZEC} ZEC`);

  let span = "";
  const done = page.getByTestId("too-small");
  while (!(await done.isVisible())) {
    const line = await page
      .getByTestId("spend-check")
      .innerText({ timeout: 100 })
      .catch(() => "");
    if (/of [\d,]+/.test(line)) span = line;
    if (Date.now() - t0 > 240_000) throw new Error("no check result in 4 minutes");
    await page.waitForTimeout(50);
  }
  const doneMs = Date.now() - t0;
  await expect(page.getByTestId("spend-check")).toHaveCount(0);
  await expect(page.getByTestId("already-opened")).toHaveCount(0);
  return { revealMs, doneMs, span };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const s = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

describeReal("two-phase open on mainnet (dry, read-only)", () => {
  test.setTimeout(30 * 60_000);

  test("the final link reveals at once; the original link scans first", async ({ page }) => {
    const [secret] = FRAGMENT!.split(".");
    const links = { original: FRAGMENT!, final: `${secret}.${PAID_HEIGHT}` } as const;
    const t: Record<keyof typeof links, { reveal: number[]; done: number[] }> = {
      original: { reveal: [], done: [] },
      final: { reveal: [], done: [] },
    };
    for (let i = 1; i <= RUNS; i++) {
      const order: Array<keyof typeof links> =
        i % 2 === 1 ? ["final", "original"] : ["original", "final"];
      for (const which of order) {
        const r = await timeOpen(page, links[which]);
        t[which].reveal.push(r.revealMs);
        t[which].done.push(r.doneMs);
        console.log(
          `TWO-PHASE ${which.padEnd(8)} run ${i}: reveal ${s(r.revealMs)}, check complete ${s(r.doneMs)}  (${r.span || "no check line"})`,
        );
      }
    }
    console.log(`TWO-PHASE ${await page.getByTestId("proving-note").innerText()}`);
    for (const which of ["final", "original"] as const) {
      console.log(
        `TWO-PHASE median ${which}: reveal ${s(median(t[which].reveal))}, check complete ${s(median(t[which].done))}`,
      );
    }
    expect(median(t.final.reveal)).toBeLessThan(2000);
  });
});
