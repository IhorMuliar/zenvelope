/**
 * M1 end-to-end proof, driven against the production build with the REAL wasm core.
 *
 *   npm run build && npm run e2e
 *
 * What it proves:
 *   - the app loads the wasm core, not the MOCK (no MOCK badge, real bech32m address)
 *   - creating an envelope produces a mainnet `u1...` Orchard-only unified address
 *   - the ZIP-321 URI carries envelope + flat fee as one output, with the message in
 *     the `memo=` parameter so it reaches the chain
 *   - the link fragment carries a birthday height fetched live from lightwalletd
 *   - opening `/e#<fragment>` re-derives the same address from the fragment alone
 *   - the fixed vector in crates/core/TEST_VECTORS.md derives the documented address
 *
 * Set ZENVELOPE_E2E_OUT=<path> to dump the created envelope (including its viewing
 * key) to a JSON file. Only do that outside the repo: the fragment is the money.
 */

import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(HERE, "../docs");

/**
 * This file only means anything against the real wasm core. A checkout without
 * `./scripts/build-core.sh` run is on the MOCK, so the whole group is skipped
 * rather than failing on an address it was never going to produce. M2's
 * `m2-open.spec.ts` runs on the MOCK and always runs.
 */
const REAL_CORE = existsSync(resolve(HERE, "../src/wasm/core/zenvelope_core.js"));
const describeOnRealCore = REAL_CORE ? test.describe : test.describe.skip;

/** From crates/core/TEST_VECTORS.md: the 32 bytes 0x01..0x20, base64url. */
const VECTOR_SECRET = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
const VECTOR_ADDRESS =
  "u1nxx35rnvjqzuz03fcg4yur2atgm3j2yl4xsl6l93u5nxw8mxw0t5gxqlqfxruppsy7akehfj5h63j7mqx6z6uzvl0n7f3v08kszpwv4f";

const LIGHTWALLETD = "https://zjs.zec.rocks/mainnet";
const FRAGMENT_RE = /^[A-Za-z0-9_-]{43}\.\d+$/;

/** One unary CompactTxStreamer/GetLatestBlock over gRPC-web, independent of the app. */
async function liveChainHeight(): Promise<number> {
  const res = await fetch(
    `${LIGHTWALLETD}/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock`,
    {
      method: "POST",
      headers: { "content-type": "application/grpc-web+proto", "x-grpc-web": "1" },
      body: new Uint8Array([0, 0, 0, 0, 0]),
    },
  );
  expect(res.ok, `lightwalletd returned HTTP ${res.status}`).toBeTruthy();
  const body = new Uint8Array(await res.arrayBuffer());
  // frame: 1 flag byte + big-endian uint32 length + payload; payload is
  // BlockID { uint64 height = 1; bytes hash = 2; }, so field 1 is the first varint.
  expect(body[0] & 0x80).toBe(0);
  let off = 5;
  expect(body[off]).toBe(0x08); // field 1, varint
  off += 1;
  let height = 0;
  let shift = 0;
  for (;;) {
    const b = body[off++];
    height += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  expect(height).toBeGreaterThan(3_000_000);
  return height;
}

/** Fails the test if the page ever fell back to the MOCK core. */
async function expectRealCore(page: Page) {
  await expect(page.getByTestId("mock-badge")).toHaveCount(0);
}

describeOnRealCore("M1: the web app on the real wasm core", () => {
  test("serves the wasm cross-origin isolated", async ({ page }) => {
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    const headers = res!.headers();
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(headers["cross-origin-embedder-policy"]).toBe("require-corp");

    // The .wasm must be a real emitted asset, served with the same isolation headers.
    const wasm = await page.waitForResponse(
      (r) => r.url().endsWith(".wasm") && r.status() === 200,
      { timeout: 20_000 },
    );
    expect(wasm.headers()["cross-origin-embedder-policy"]).toBe("require-corp");
    expect((await wasm.body()).byteLength).toBeGreaterThan(100_000);
    await expectRealCore(page);
  });

  test("creates an envelope and re-derives it from the link", async ({ page }) => {
    const before = await liveChainHeight();

    await page.goto("/");
    await expectRealCore(page);

    await page.getByTestId("amount").fill("0.001");
    await page.getByTestId("message").fill("hello");
    await page.getByTestId("create").click();

    await expect(page.getByTestId("envelope-link")).toBeVisible();
    await expectRealCore(page);

    const link = (await page.getByTestId("envelope-link").textContent())!.trim();
    const uri = (await page.getByTestId("payment-uri").textContent())!.trim();
    const address = (await page.getByTestId("envelope-address").textContent())!.trim();
    const ufvk = (await page.getByTestId("envelope-ufvk").textContent())!.trim();

    // A real mainnet Orchard-only unified address, not the MOCK's `u1mock...`.
    expect(address).toMatch(/^u1[a-z0-9]{100,}$/);
    expect(address).not.toContain("mock");
    expect(address).not.toBe(VECTOR_ADDRESS);
    expect(ufvk).toMatch(/^uview1[a-z0-9]{100,}$/);
    expect(ufvk).not.toContain("mock");

    // 0.001 ZEC envelope + 0.0003 ZEC flat fee, one ZIP-321 output. The sender's text
    // rides in `memo=` as base64url of its UTF-8 bytes, so the wallet writes it into the
    // note instead of keeping it as a local label (see web/docs/M2-VERIFICATION.md).
    expect(uri).toBe(`zcash:${address}?amount=0.0013&memo=aGVsbG8`);
    expect(uri).not.toContain("message=");

    // The fragment is <43-char secret>.<birthday>, and the birthday is the height
    // lightwalletd was reporting while this test ran.
    const fragment = link.split("#")[1];
    expect(fragment).toMatch(FRAGMENT_RE);
    const birthday = Number(fragment.split(".")[1]);
    const after = await liveChainHeight();
    expect(birthday).toBeGreaterThanOrEqual(before - 2);
    expect(birthday).toBeLessThanOrEqual(after + 2);

    mkdirSync(DOCS, { recursive: true });
    await page.screenshot({ path: resolve(DOCS, "m1-real-create.png"), fullPage: true });

    // Opening the link must re-derive the same address from the fragment alone.
    // M2 made /e the sealed-envelope screen, so the address sits behind its
    // "check the envelope address" disclosure, and nothing scans until asked.
    await page.goto(`/e#${fragment}`);
    await expect(page.getByTestId("open-envelope")).toBeVisible();
    await page.getByTestId("open-address-toggle").click();
    await expect(page.getByTestId("open-address")).toBeVisible();
    await expectRealCore(page);
    expect((await page.getByTestId("open-address").textContent())!.trim()).toBe(address);
    await expect(page.getByText(`Birthday height ${birthday}`)).toBeVisible();
    await page.screenshot({ path: resolve(DOCS, "m1-real-open.png"), fullPage: true });

    const out = process.env.ZENVELOPE_E2E_OUT;
    if (out) {
      writeFileSync(
        out,
        JSON.stringify({ link, fragment, address, ufvk, uri, birthday }, null, 2),
      );
    }
  });

  test("derives the documented address for the fixed test vector", async ({ page }) => {
    await page.goto(`/e#${VECTOR_SECRET}`);
    await page.getByTestId("open-address-toggle").click();
    await expect(page.getByTestId("open-address")).toBeVisible();
    await expectRealCore(page);
    expect((await page.getByTestId("open-address").textContent())!.trim()).toBe(
      VECTOR_ADDRESS,
    );
    await expect(page.getByText(VECTOR_ADDRESS)).toBeVisible();
  });
});
