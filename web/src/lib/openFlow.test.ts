import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BAD_FRAGMENT_COPY,
  NOT_FOUND_COPY,
  SCAN_FAILED_COPY,
  initialOpenState,
  isScanning,
  openReducer,
  progressLabel,
  runOpen,
  type OpenEvent,
  type OpenState,
} from "./openFlow";
import { formatCount } from "./format";
import { MOCK_NOTE, MOCK_SCAN_MS, MOCK_TIP_HEIGHT, mockCore } from "../core/mock";
import type { OpenResult, ProgressFn } from "../core/types";

const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

function run(events: OpenEvent[], from: OpenState = initialOpenState): OpenState {
  return events.reduce(openReducer, from);
}

const FOUND: OpenResult = {
  found: true,
  notes: [{ amount_zat: "130000", memo: "Zenvelope M1", height: 3490472, txid: "ab", pool: "ironwood" }],
  total_zat: "130000",
  tip_height: 3490500,
  birthday: 3490437,
  birthday_defaulted: false,
  scanned_blocks: 64,
};

const EMPTY: OpenResult = {
  found: false,
  notes: [],
  total_zat: "0",
  tip_height: 3490500,
  birthday: 3490437,
  birthday_defaulted: false,
  scanned_blocks: 64,
};

describe("openReducer", () => {
  it("starts by reading the link", () => {
    expect(initialOpenState.phase).toBe("reading");
    expect(isScanning(initialOpenState)).toBe(false);
  });

  it("walks reading -> sealed -> scanning -> opened", () => {
    const s = run([
      { type: "parsed" },
      { type: "open" },
      { type: "progress", scanned: 10, total: 100 },
      { type: "result", result: FOUND },
    ]);
    expect(s.phase).toBe("opened");
    expect(s.result).toEqual(FOUND);
    expect(s.message).toBeNull();
  });

  it("never scans when the fragment is invalid", () => {
    const s = run([{ type: "invalid", message: BAD_FRAGMENT_COPY }, { type: "open" }]);
    expect(s.phase).toBe("invalid");
    expect(s.message).toBe(BAD_FRAGMENT_COPY);
  });

  it("does not start scanning before the sealed state", () => {
    expect(run([{ type: "open" }]).phase).toBe("reading");
  });

  it("goes to empty when the scan found nothing", () => {
    const s = run([{ type: "parsed" }, { type: "open" }, { type: "result", result: EMPTY }]);
    expect(s.phase).toBe("empty");
    expect(s.message).toBe(NOT_FOUND_COPY);
    expect(s.message).not.toMatch(/claim/i);
  });

  it("treats found-with-no-notes as empty", () => {
    const odd = { ...EMPTY, found: true };
    const s = run([{ type: "parsed" }, { type: "open" }, { type: "result", result: odd }]);
    expect(s.phase).toBe("empty");
  });

  it("keeps progress monotonic and clamped to the total", () => {
    const s = run([
      { type: "parsed" },
      { type: "open" },
      { type: "progress", scanned: 50, total: 100 },
      { type: "progress", scanned: 20, total: 100 },
      { type: "progress", scanned: 500, total: 100 },
    ]);
    expect(s.scanned).toBe(100);
    expect(s.total).toBe(100);
  });

  it("holds the total once it is known", () => {
    const s = run([
      { type: "parsed" },
      { type: "open" },
      { type: "progress", scanned: 0, total: 0 },
      { type: "progress", scanned: 5, total: 400 },
      { type: "progress", scanned: 9, total: 0 },
    ]);
    expect(s.total).toBe(400);
    expect(s.scanned).toBe(9);
  });

  it("has no progress line until the total is known", () => {
    const s1 = run([{ type: "parsed" }, { type: "open" }, { type: "progress", scanned: 3, total: 0 }]);
    expect(progressLabel(s1, formatCount)).toBeNull();
    const s2 = openReducer(s1, { type: "progress", scanned: 12340, total: 12400 });
    expect(progressLabel(s2, formatCount)).toBe("block 12,340 of 12,400");
  });

  it("records which host the attempt is using", () => {
    const s = run([{ type: "parsed" }, { type: "open" }, { type: "attempt", attempt: 1 }]);
    expect(s.attempt).toBe(1);
  });

  it("ignores progress and results that arrive after the scan ended", () => {
    const done = run([{ type: "parsed" }, { type: "open" }, { type: "result", result: FOUND }]);
    expect(openReducer(done, { type: "progress", scanned: 1, total: 2 })).toBe(done);
    expect(openReducer(done, { type: "result", result: EMPTY })).toBe(done);
    expect(openReducer(done, { type: "failed", message: "x" })).toBe(done);
  });

  it("fails retry-ably and retries from a clean progress state", () => {
    const failed = run([
      { type: "parsed" },
      { type: "open" },
      { type: "progress", scanned: 90, total: 100 },
      { type: "failed", message: SCAN_FAILED_COPY },
    ]);
    expect(failed.phase).toBe("failed");
    expect(failed.message).toBe(SCAN_FAILED_COPY);

    const again = openReducer(failed, { type: "retry" });
    expect(again.phase).toBe("scanning");
    expect(again.scanned).toBe(0);
    expect(again.total).toBe(0);
    expect(again.attempt).toBe(0);
    expect(again.message).toBeNull();
  });

  it("retries from the empty state too, and nowhere else", () => {
    const empty = run([{ type: "parsed" }, { type: "open" }, { type: "result", result: EMPTY }]);
    expect(openReducer(empty, { type: "retry" }).phase).toBe("scanning");
    const opened = run([{ type: "parsed" }, { type: "open" }, { type: "result", result: FOUND }]);
    expect(openReducer(opened, { type: "retry" })).toBe(opened);
  });
});

describe("runOpen", () => {
  const hosts = ["https://primary.example", "https://failover.example"] as const;

  function core(impl: (url: string, onProgress: ProgressFn) => Promise<OpenResult>) {
    const calls: string[] = [];
    return {
      calls,
      core: {
        open_envelope: (
          _secret: string,
          _birthday: number | undefined,
          _network: "main" | "test",
          url: string,
          onProgress: ProgressFn,
        ) => {
          calls.push(url);
          return impl(url, onProgress);
        },
      },
    };
  }

  it("uses the primary host and never touches the failover on success", async () => {
    const seen: Array<[number, number]> = [];
    const c = core(async (_url, onProgress) => {
      onProgress(0, 0);
      onProgress(5, 10);
      return FOUND;
    });
    const result = await runOpen({
      core: c.core,
      secret: SECRET,
      birthday: 3490437,
      network: "main",
      hosts,
      onProgress: (s, t) => seen.push([s, t]),
    });
    expect(result).toEqual(FOUND);
    expect(c.calls).toEqual([hosts[0]]);
    expect(seen).toEqual([
      [0, 0],
      [5, 10],
    ]);
  });

  it("retries once on the failover host", async () => {
    const attempts: number[] = [];
    const c = core(async (url) => {
      if (url === hosts[0]) throw new Error("connect ECONNREFUSED primary");
      return FOUND;
    });
    const result = await runOpen({
      core: c.core,
      secret: SECRET,
      birthday: undefined,
      network: "main",
      hosts,
      onProgress: () => {},
      onAttempt: (a) => attempts.push(a),
    });
    expect(result).toEqual(FOUND);
    expect(c.calls).toEqual([hosts[0], hosts[1]]);
    expect(attempts).toEqual([0, 1]);
  });

  it("throws recipient-facing copy when both hosts fail, and only tries twice", async () => {
    const c = core(async () => {
      throw new Error("grpc-web 502 from https://primary.example/some/path");
    });
    await expect(
      runOpen({
        core: c.core,
        secret: SECRET,
        birthday: 1,
        network: "main",
        hosts,
        onProgress: () => {},
      }),
    ).rejects.toThrow(SCAN_FAILED_COPY);
    expect(c.calls).toHaveLength(2);
  });

  it("passes the birthday and network straight through", async () => {
    const seen: unknown[] = [];
    const result = await runOpen({
      core: {
        open_envelope: async (secret, birthday, network, url) => {
          seen.push([secret, birthday, network, url]);
          return EMPTY;
        },
      },
      secret: SECRET,
      birthday: 3490437,
      network: "test",
      hosts,
      onProgress: () => {},
    });
    expect(result.found).toBe(false);
    expect(seen).toEqual([[SECRET, 3490437, "test", hosts[0]]]);
  });
});

describe("the MOCK scan", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports progress and then one note", async () => {
    vi.useFakeTimers();
    const seen: Array<[number, number]> = [];
    const promise = mockCore.open_envelope(SECRET, 3490437, "main", "https://unused.example", (s, t) =>
      seen.push([s, t]),
    );
    await vi.advanceTimersByTimeAsync(MOCK_SCAN_MS + 200);
    const result = await promise;

    expect(seen.length).toBeGreaterThan(10);
    // Indeterminate first, then a known span.
    expect(seen[0]).toEqual([0, 0]);
    expect(seen.at(-1)).toEqual([MOCK_TIP_HEIGHT - 3490437 + 1, MOCK_TIP_HEIGHT - 3490437 + 1]);

    expect(result.found).toBe(true);
    expect(result.total_zat).toBe("130000");
    expect(result.tip_height).toBe(MOCK_TIP_HEIGHT);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toEqual({ ...MOCK_NOTE });
    expect(result.notes[0].memo).toBe("Zenvelope M1");
    expect(result.notes[0].height).toBe(3490472);
    expect(result.notes[0].pool).toBe("ironwood");
  });

  it("rejects a malformed secret before any scanning", async () => {
    vi.useFakeTimers();
    await expect(
      mockCore.open_envelope("nope", undefined, "main", "https://unused.example", () => {}),
    ).rejects.toThrow();
  });
});
