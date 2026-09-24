/**
 * The final link on mainnet: the same envelope opened from its original link and
 * from its final link, `#<secret>.<funding height>`, and the open times compared.
 *
 *   ./scripts/build-core.sh && cd web && npm run build
 *   ZENV_FEE_FRAGMENT='<secret>.<birthday>' ZENV_FEE_PAID_HEIGHT=3491056 \
 *   ZENV_EXPECT_ZEC=0.0003 ZENVELOPE_E2E_PORT=4271 \
 *     npx playwright test e2e/watch-real.spec.ts
 *
 * The fragment is the fee envelope's, from the private, gitignored M3-DEST.md,
 * read from the environment at run time; the group skips when it is missing.
 * The page is loaded with `?dry=1` and the test never goes past the reveal, so
 * nothing is built, proved or broadcast.
 *
 * "Open time" is the tap on "Open envelope" to the amount on screen, which is
 * the scan plus one GetTransaction. The span is logged with it, because both
 * links scan to today's tip and the tip moves.
 */

import { expect, test, type Page } from "@playwright/test";

const FRAGMENT = process.env.ZENV_FEE_FRAGMENT;
const PAID_HEIGHT = Number(process.env.ZENV_FEE_PAID_HEIGHT ?? "0");
const EXPECT_ZEC = process.env.ZENV_EXPECT_ZEC ?? "0.0003";
const RUNS = Number(process.env.ZENV_WATCH_RUNS ?? "2");

const describeReal = FRAGMENT && PAID_HEIGHT > 0 ? test.describe : test.describe.skip;

async function timeOpen(
  page: Page,
  fragment: string,
  until: "amount" | "not-found" = "amount",
): Promise<{ ms: number; span: string }> {
  // A fresh document each time: going from one /e#… to another is only a hash
  // change, which would neither reload the page nor restart the core worker.
  await page.goto("about:blank");
  await page.goto(`/e?dry=1#${fragment}`);
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 60_000 })
    .toBe("");
  await expect(page.getByTestId("mock-badge")).toHaveCount(0);
  const button = page.getByTestId("open-envelope");
  await expect(button).toBeEnabled({ timeout: 60_000 });

  let span = "";
  const t0 = Date.now();
  await button.click();
  const amount = page.getByTestId(until);
  // Sample the progress line while waiting, for the span this run covered.
  while (!(await amount.isVisible())) {
    const p = await page
      .getByTestId("scan-progress")
      .innerText({ timeout: 200 })
      .catch(() => "");
    if (/of [\d,]+/.test(p)) span = p;
    if (Date.now() - t0 > 240_000) throw new Error("open took longer than 4 minutes");
    await page.waitForTimeout(100);
  }
  const ms = Date.now() - t0;
  if (until === "amount") await expect(amount).toContainText(`${EXPECT_ZEC} ZEC`);
  return { ms, span };
}

/** "block 3,226 of 3,226" -> 3226, or NaN when the line never painted. */
function spanBlocks(span: string): number {
  const m = /of ([\d,]+)/.exec(span);
  return m ? Number(m[1].replace(/,/g, "")) : NaN;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describeReal("final link on mainnet (dry, read-only)", () => {
  test.setTimeout(30 * 60_000);

  test("opens the fee envelope from the final link, scanning from the payment", async ({
    page,
  }) => {
    const [secret, birthday] = FRAGMENT!.split(".");
    const skipped = PAID_HEIGHT - Number(birthday);
    expect(skipped).toBeGreaterThan(0);
    const links = { original: FRAGMENT!, final: `${secret}.${PAID_HEIGHT}` } as const;

    const times: Record<keyof typeof links, number[]> = { original: [], final: [] };
    for (let i = 1; i <= RUNS; i++) {
      // Alternate which goes first, so a warm gateway or a moving tip favours neither.
      const order: Array<keyof typeof links> =
        i % 2 === 1 ? ["final", "original"] : ["original", "final"];
      const spans: Partial<Record<keyof typeof links, number>> = {};
      for (const which of order) {
        const r = await timeOpen(page, links[which]);
        times[which].push(r.ms);
        spans[which] = spanBlocks(r.span);
        console.log(
          `WATCH ${which.padEnd(8)} run ${i}: ${(r.ms / 1000).toFixed(1)} s  (${r.span || "span not painted"})`,
        );
      }
      // The final link reads exactly the blocks between the two birthdays fewer,
      // give or take the blocks mined between the two opens.
      if (Number.isFinite(spans.original) && Number.isFinite(spans.final)) {
        expect(Math.abs(spans.original! - spans.final! - skipped)).toBeLessThanOrEqual(5);
      }
    }
    // What "opened straight away" costs: a birthday past the tip is clamped to the
    // tip, so this is a one-block scan of the same secret. It finds nothing, which
    // is the point: it is the fixed cost of an open with no chain to read.
    for (let i = 1; i <= RUNS; i++) {
      const r = await timeOpen(page, `${secret}.99999999`, "not-found");
      console.log(`WATCH one-block run ${i}: ${(r.ms / 1000).toFixed(1)} s  (${r.span || "span not painted"})`);
    }
    console.log(`WATCH ${await page.getByTestId("proving-note").innerText()}`);
    console.log(
      `WATCH median: original ${(median(times.original) / 1000).toFixed(1)} s, final ${(median(times.final) / 1000).toFixed(1)} s, ${skipped} blocks skipped`,
    );
  });
});
