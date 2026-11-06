import { describe, expect, it } from "vitest";
import byExternal from "./__fixtures__/mh-by-external-sol.json";
import polls from "./__fixtures__/mh-polls-sol.json";
import type { MhTransfer } from "./multihop";
import { etaWords, routeEta, routePollMs, solText, trackerRows } from "./routeTracker";

const completed = byExternal as unknown as MhTransfer;
const fresh = polls[0] as unknown as MhTransfer; // 0 of 3 hops executed
const withDone = (n: number): MhTransfer => ({
  ...fresh,
  route: {
    hops: fresh.route!.hops.map((h, i) => ({ ...h, executedAt: i < n ? "2026-11-06T06:16:30.001Z" : null })),
  },
});
const states = (rows: ReturnType<typeof trackerRows>) => rows.map((r) => `${r.key}:${r.state}`);

describe("trackerRows", () => {
  it("waiting for the swap: Swapping is active, nothing else has started", () => {
    expect(states(trackerRows({ swapping: true, phase: "estimating", transfer: null, arrived: false }))).toEqual([
      "swap:active", "packed:waiting", "hops:waiting", "landing:waiting", "arrived:waiting",
    ]);
  });

  it("packing while the route's transactions are signed", () => {
    const rows = trackerRows({ swapping: false, phase: "signing", transfer: fresh, arrived: false });
    expect(states(rows).slice(0, 3)).toEqual(["swap:done", "packed:active", "hops:waiting"]);
  });

  it("names the hop in progress, from route.hops[].executedAt", () => {
    const at = (n: number) =>
      trackerRows({ swapping: false, phase: "routing", transfer: withDone(n), arrived: false });
    expect(at(0).find((r) => r.key === "hops")).toMatchObject({ label: "Hop 1 of 3", state: "active" });
    expect(at(1).find((r) => r.key === "hops")).toMatchObject({ label: "Hop 2 of 3", state: "active" });
    // Two executed: only the recipient's own entry is left, which is the landing.
    expect(states(at(2))).toEqual(["swap:done", "packed:done", "hops:done", "landing:active", "arrived:waiting"]);
  });

  it("completed but not yet swept to the wallet: Landing is done, In your wallet waits", () => {
    const rows = trackerRows({ swapping: false, phase: "done", transfer: completed, arrived: false });
    expect(states(rows).slice(2)).toEqual(["hops:done", "landing:done", "arrived:waiting"]);
  });

  it("everything done once the leftover has been sent", () => {
    const rows = trackerRows({ swapping: false, phase: "done", transfer: completed, arrived: true });
    expect(rows.every((r) => r.state === "done")).toBe(true);
    expect(rows.at(-1)!.label).toBe("In your wallet");
  });

  it("a refund stops the later rows", () => {
    const rows = trackerRows({ swapping: false, phase: "refunded", transfer: fresh, arrived: false });
    expect(states(rows)).toEqual(["swap:done", "packed:done", "hops:stopped", "landing:stopped", "arrived:stopped"]);
  });

  it("devnet hides the swap row", () => {
    const rows = trackerRows({ swapping: false, phase: "estimating", transfer: null, arrived: false, hideSwap: true });
    expect(rows[0].key).toBe("packed");
  });
});

describe("routeEta", () => {
  const t0 = Date.parse(fresh.createdAt ?? fresh.quotedAt!);
  const last = Date.parse(fresh.route!.hops[2].scheduledAt!);

  it("counts down to the last hop and says 'about'", () => {
    const eta = routeEta(fresh, t0 + 60_000);
    expect(eta.remainingSec).toBe(Math.round((last - t0 - 60_000) / 1000));
    expect(eta.late).toBe(false);
    expect(etaWords(eta.remainingSec)).toMatch(/in about \d+ min/);
    expect(etaWords(10)).toBe("any moment now");
  });

  it("is late after twice the expected duration, but never once completed", () => {
    const expected = last - t0;
    expect(routeEta(fresh, t0 + 2 * expected + 1000).late).toBe(true);
    expect(routeEta(fresh, t0 + 2 * expected - 5000).late).toBe(false);
    expect(routeEta(completed, t0 + 10 * expected).late).toBe(false);
  });
});

describe("routePollMs", () => {
  it("is 15 s, and ?poll= shortens it for tests only", () => {
    expect(routePollMs("")).toBe(15_000);
    expect(routePollMs("?poll=300")).toBe(300);
    expect(routePollMs("?poll=999999")).toBe(15_000);
    expect(routePollMs("?poll=5")).toBe(100);
  });
});

describe("the leftover SOL step", () => {
  const rows = (leftover?: { state: "collecting" | "done"; lamports: number }) =>
    trackerRows({ swapping: false, phase: "done", transfer: completed, arrived: true, leftover });

  it("is absent until the page has something to collect", () => {
    expect(rows().map((r) => r.key)).not.toContain("leftover");
  });

  it("shows after 'In your wallet': collecting, then done", () => {
    const c = rows({ state: "collecting", lamports: 31_000_000 });
    expect(c.at(-1)).toMatchObject({ key: "leftover", state: "active", label: "Collecting about 0.031 SOL of unused network money for you…" });
    expect(c.at(-2)!.key).toBe("arrived");
    const d = rows({ state: "done", lamports: 31_000_000 });
    expect(d.at(-1)).toMatchObject({ state: "done", label: "Done: 0.031 SOL sent to your wallet." });
  });

  it("is not shown before the money has arrived", () => {
    const r = trackerRows({ swapping: false, phase: "routing", transfer: fresh, arrived: false, leftover: { state: "collecting", lamports: 1 } });
    expect(r.map((x) => x.key)).not.toContain("leftover");
  });

  it("formats SOL to three places", () => {
    expect(solText(31_400_000)).toBe("0.031");
    expect(solText(400_000)).toBe("less than 0.001");
  });
});
