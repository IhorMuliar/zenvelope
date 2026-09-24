/**
 * The create page watching for the sender's payment, on the MOCK core.
 *
 *   npm run e2e
 *
 * The mock treats a secret it generated itself as a fresh, unfunded envelope:
 * "not yet" for two looks, then one note at MOCK_PAID_HEIGHT (src/core/mock.ts).
 * The chain tip the create page reads is pinned by answering GetLatestBlock here,
 * so the birthday is known and below that height. Playwright's clock drives the
 * page's timers — 30 s to the first look, 45 s between rounds — while the mock
 * scans in the core worker run on real time.
 *
 * What it proves:
 *   - single: "Waiting for your payment", two empty looks, then "Paid: … at block
 *     H" and a final link ending `.H`, with the original link kept and marked
 *     slower to open;
 *   - group: every row gets `paid_height` and `final_link` in the table and in a
 *     re-downloaded CSV, which before the payments had both columns empty;
 *   - nothing stored, no secret in any request, never the drainer word.
 *
 * Skipped when a real wasm build is present, like every create-side mock spec.
 */

import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_CORE = existsSync(resolve(HERE, "../src/wasm/core/zenvelope_core.js"));
const describeOnMock = REAL_CORE ? test.describe.skip : test.describe;

/** Pinned tip, so the links carry this birthday. */
const TIP = 3_490_490;
/** src/core/mock.ts MOCK_PAID_HEIGHT: the mock tip, 3,490,500, less three. */
const PAID_HEIGHT = 3_490_497;
const SECRET_RE = /[A-Za-z0-9_-]{43}/g;

/** A gRPC-web GetLatestBlock answer: BlockID { height = TIP }, then an OK trailer. */
function latestBlockBody(height: number): Buffer {
  const varint: number[] = [];
  let v = height;
  while (v >= 0x80) {
    varint.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  varint.push(v);
  const msg = Buffer.from([0x08, ...varint]);
  const frame = (flag: number, payload: Buffer) => {
    const head = Buffer.alloc(5);
    head[0] = flag;
    head.writeUInt32BE(payload.length, 1);
    return Buffer.concat([head, payload]);
  };
  return Buffer.concat([frame(0x00, msg), frame(0x80, Buffer.from("grpc-status:0\r\n"))]);
}

async function pinTip(page: Page): Promise<string[]> {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url() + " " + (r.postData() ?? "")));
  await page.route("**/GetLatestBlock", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/grpc-web+proto",
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "grpc-status,grpc-message",
        "grpc-status": "0",
      },
      body: latestBlockBody(TIP),
    }),
  );
  return requests;
}

/** One round: move the page clock past the timer, then wait for the mock scans. */
async function nextRound(page: Page, ms: number, rounds: number): Promise<void> {
  await page.clock.runFor(ms);
  await expect
    .poll(
      async () => {
        const status = page.getByTestId("watch-status");
        if ((await status.count()) === 0) return "gone";
        return (await status.getAttribute("data-rounds")) ?? "";
      },
      { timeout: 30_000 },
    )
    .toMatch(new RegExp(`^(${rounds}|gone)$`));
}

async function expectClean(page: Page, requests: string[], secrets: string[]) {
  const text = (await page.locator("body").innerText()).toLowerCase();
  expect(text).not.toContain("claim");
  const stored = await page.evaluate(() => ({
    local: Object.keys(window.localStorage),
    session: Object.keys(window.sessionStorage),
  }));
  expect(stored).toEqual({ local: [], session: [] });
  for (const r of requests) for (const s of secrets) expect(r).not.toContain(s);
}

describeOnMock("payment watch on the create page", () => {
  test("one envelope: waits, then hands out the final link", async ({ page }) => {
    await page.clock.install();
    const requests = await pinTip(page);
    await page.goto("/");
    await page.getByTestId("amount").fill("0.01");
    await page.getByTestId("create").click();

    const original = (await page.getByTestId("envelope-link").innerText()).trim();
    expect(original).toMatch(new RegExp(`/e#[A-Za-z0-9_-]{43}\\.${TIP}$`));
    await expect(page.getByTestId("watch-waiting")).toHaveText("Waiting for your payment");
    await expect(page.getByTestId("watch-status")).toContainText("First look in about 30 seconds");

    await nextRound(page, 30_000, 1);
    await expect(page.getByTestId("watch-status")).toContainText("Nothing yet");
    await nextRound(page, 45_000, 2);
    await expect(page.getByTestId("watch-card")).toHaveAttribute("data-paid", "no");
    await nextRound(page, 45_000, 3);

    await expect(page.getByTestId("watch-paid")).toHaveText(
      `Paid: 0.0013 ZEC arrived at block ${PAID_HEIGHT}`,
    );
    const final = (await page.getByTestId("final-link").innerText()).trim();
    const secret = original.split("#")[1].split(".")[0];
    expect(final).toBe(original.replace(`.${TIP}`, `.${PAID_HEIGHT}`));
    expect(final.endsWith(`#${secret}.${PAID_HEIGHT}`)).toBe(true);
    // The original is still there, still the same string, and marked slower.
    await expect(page.getByTestId("envelope-link")).toHaveText(original);
    await expect(page.getByText("Original link: still works, slower to open")).toBeVisible();
    await expect(page.getByTestId("original-slower")).toContainText(`block ${TIP}`);
    // The optional QR of the final link.
    await page.getByTestId("final-qr").locator("summary").click();
    await expect(page.getByTestId("final-qr").locator("canvas")).toBeVisible();

    await expectClean(page, requests, [secret]);
  });

  test("a group: the table and the CSV gain paid_height and final_link", async ({ page }) => {
    await page.clock.install();
    const requests = await pinTip(page);
    await page.goto("/");
    await page.getByTestId("amount").fill("0.01");
    await page.getByTestId("count").fill("2");
    await page.getByTestId("create").click();
    await expect(page.getByTestId("group-row")).toHaveCount(2);
    const links = (await page.getByTestId("row-link").allInnerTexts()).map((s) => s.trim());
    const secrets = links.flatMap((l) => l.match(SECRET_RE) ?? []);
    expect(secrets).toHaveLength(2);

    const readCsv = async () => {
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByTestId("download-csv").click(),
      ]);
      return readFileSync((await download.path())!, "utf8").split("\r\n");
    };

    await expect(page.getByTestId("watch-count")).toHaveText("0 of 2 paid.");
    await nextRound(page, 30_000, 1);
    let csv = await readCsv();
    expect(csv[0]).toBe(
      "index,link,address,envelope_zec,send_zec,memo,payment_uri,paid_height,final_link",
    );
    for (let i = 1; i <= 2; i++) expect(csv[i].endsWith(",,")).toBe(true);
    await expect(page.getByTestId("row-paid").first()).toHaveText("not yet");

    await nextRound(page, 45_000, 2);
    await nextRound(page, 45_000, 3);
    await expect(page.getByTestId("row-final-link")).toHaveCount(2);
    await expect(page.getByTestId("watch-waiting")).toContainText("All 2 paid");
    const paidCells = await page.getByTestId("row-paid").allInnerTexts();
    expect(paidCells).toEqual([`block ${PAID_HEIGHT}`, `block ${PAID_HEIGHT}`]);

    csv = await readCsv();
    for (let i = 1; i <= 2; i++) {
      const cells = csv[i].split(",");
      expect(cells[7]).toBe(String(PAID_HEIGHT));
      expect(cells[8]).toBe(links[i - 1].replace(`.${TIP}`, `.${PAID_HEIGHT}`));
      expect(cells[1]).toBe(links[i - 1]);
    }

    await expectClean(page, requests, secrets);
  });
});
