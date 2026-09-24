import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BAD_FRAGMENT_COPY,
  NOT_FOUND_COPY,
  SCAN_FAILED_COPY,
  formatSpendDate,
  gatewayList,
  initialOpenState,
  isScanning,
  latestSpend,
  openReducer,
  progressLabel,
  runOpen,
  spentNotes,
  unspentNotes,
  type OpenEvent,
  type OpenState,
} from "./openFlow";
import { formatCount } from "./format";
import {
  MOCK_LEFT_NOTE,
  MOCK_NOTE,
  MOCK_SCAN_MS,
  MOCK_SPENT,
  MOCK_SPENT_TIP,
  MOCK_TIP_HEIGHT,
  mockCore,
} from "../core/mock";
import type { OpenResult, ProgressFn } from "../core/types";

const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

function run(events: OpenEvent[], from: OpenState = initialOpenState): OpenState {
  return events.reduce(openReducer, from);
}

const FOUND: OpenResult = {
  found: true,
  notes: [
    {
      amount_zat: "130000",
      memo: "Zenvelope M1",
      height: 3490472,
      txid: "ab",
      pool: "ironwood",
      action_index: 1,
      spent: false,
      spent_txid: null,
      spent_height: null,
      spent_time: null,
    },
  ],
  all_spent: false,
  total_zat: "130000",
  spent_zat: "0",
  tip_height: 3490500,
  birthday: 3490437,
  birthday_defaulted: false,
  scanned_blocks: 64,
  gateway: "zjs.zec.rocks",
};

const EMPTY: OpenResult = {
  found: false,
  all_spent: false,
  notes: [],
  total_zat: "0",
  spent_zat: "0",
  tip_height: 3490500,
  birthday: 3490437,
  birthday_defaulted: false,
  scanned_blocks: 64,
  gateway: "zjs.zec.rocks",
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
          // Optional, exactly as the contract has it: `runOpen` always passes one,
          // but the type the core worker's client satisfies does not require it.
          url: string,
          onProgress?: ProgressFn,
        ) => {
          calls.push(url);
          return impl(url, onProgress ?? (() => {}));
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
    // One attempt, and it names both gateways so the core can race them.
    expect(c.calls).toEqual([`${hosts[0]},${hosts[1]}`]);
    expect(seen).toEqual([
      [0, 0],
      [5, 10],
    ]);
  });

  it("joins the gateways into one preference-ordered list", () => {
    expect(gatewayList(hosts)).toBe(`${hosts[0]},${hosts[1]}`);
    // An unset failover must not leave a trailing comma the core would refuse.
    expect(gatewayList([hosts[0], ""])).toBe(hosts[0]);
    expect(gatewayList([])).toBe("");
  });

  it("retries on the failover host alone when the race refused", async () => {
    const attempts: number[] = [];
    const c = core(async (url) => {
      if (url.includes(hosts[0])) throw new Error("connect ECONNREFUSED primary");
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
    expect(c.calls).toEqual([`${hosts[0]},${hosts[1]}`, hosts[1]]);
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
    expect(seen).toEqual([[SECRET, 3490437, "test", `${hosts[0]},${hosts[1]}`]]);
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

/* ------------------------------------------------------------ spent detection */

const SPENT_TXID = "ba0f91cfe7ca33dd269b692bf80027df2681a321215e90ab28c2a56260fa2aad";

const SWEPT_NOTE = {
  ...FOUND.notes[0],
  spent: true,
  spent_txid: SPENT_TXID,
  spent_height: 3491056,
  spent_time: 1790020800,
};

const ALL_SPENT: OpenResult = {
  ...FOUND,
  notes: [SWEPT_NOTE],
  all_spent: true,
  total_zat: "0",
  spent_zat: "130000",
};

const PART_SPENT: OpenResult = {
  ...FOUND,
  notes: [SWEPT_NOTE, { ...FOUND.notes[0], amount_zat: "30000", txid: "cd" }],
  all_spent: false,
  total_zat: "30000",
  spent_zat: "130000",
};

describe("openReducer: spent envelopes", () => {
  const scanning = run([{ type: "parsed" }, { type: "open" }]);

  it("lands on the already-opened state when every note is spent", () => {
    const s = openReducer(scanning, { type: "result", result: ALL_SPENT });
    expect(s.phase).toBe("spent");
    expect(s.result).toBe(ALL_SPENT);
    expect(s.message).toBeNull();
    expect(isScanning(s)).toBe(false);
  });

  it("opens normally when only some notes are spent", () => {
    const s = openReducer(scanning, { type: "result", result: PART_SPENT });
    expect(s.phase).toBe("opened");
    expect(unspentNotes(s.result!.notes).map((n) => n.amount_zat)).toEqual(["30000"]);
    expect(spentNotes(s.result!.notes).map((n) => n.amount_zat)).toEqual(["130000"]);
  });

  it("opens normally when nothing is spent", () => {
    expect(openReducer(scanning, { type: "result", result: FOUND }).phase).toBe("opened");
  });

  it("treats notes that are all spent as spent even if all_spent disagrees", () => {
    const odd = { ...ALL_SPENT, all_spent: false };
    expect(openReducer(scanning, { type: "result", result: odd }).phase).toBe("spent");
  });

  it("still says nothing is here when nothing was ever found", () => {
    expect(openReducer(scanning, { type: "result", result: EMPTY }).phase).toBe("empty");
  });

  it("is terminal: a retry does not rescan an already-opened envelope", () => {
    const s = openReducer(scanning, { type: "result", result: ALL_SPENT });
    expect(openReducer(s, { type: "retry" })).toBe(s);
    expect(openReducer(s, { type: "progress", scanned: 1, total: 2 })).toBe(s);
  });

  it("names the latest spend, with its date in UTC", () => {
    expect(latestSpend(ALL_SPENT.notes)).toEqual({
      txid: SPENT_TXID,
      height: 3491056,
      time: 1790020800,
    });
    expect(latestSpend(FOUND.notes)).toBeNull();
    const later = { ...SWEPT_NOTE, spent_txid: "ef", spent_height: 3491100 };
    expect(latestSpend([SWEPT_NOTE, later])?.txid).toBe("ef");
    expect(formatSpendDate(1790020800)).toBe("21 September 2026");
  });
});

describe("the MOCK scan: spent variants", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function mockOpen(secret: string): Promise<OpenResult> {
    vi.useFakeTimers();
    const p = mockCore.open_envelope(secret, 3490437, "main", "https://unused.example", () => {});
    await vi.advanceTimersByTimeAsync(MOCK_SCAN_MS + 200);
    return p;
  }

  it("spentAll… is found, all spent, and holds nothing", async () => {
    const r = await mockOpen(`spentAll${SECRET.slice(8)}`);
    expect(r.found).toBe(true);
    expect(r.all_spent).toBe(true);
    expect(r.total_zat).toBe("0");
    expect(r.spent_zat).toBe(MOCK_NOTE.amount_zat);
    expect(r.tip_height).toBe(MOCK_SPENT_TIP);
    expect(r.notes[0].spent_txid).toBe(MOCK_SPENT.txid);
    expect(r.notes[0].spent_height).toBe(MOCK_SPENT.height);
    const s = run([{ type: "parsed" }, { type: "open" }, { type: "result", result: r }]);
    expect(s.phase).toBe("spent");
  });

  it("spentOne… leaves one note to send on", async () => {
    const r = await mockOpen(`spentOne${SECRET.slice(8)}`);
    expect(r.all_spent).toBe(false);
    expect(r.total_zat).toBe(MOCK_LEFT_NOTE.amount_zat);
    expect(unspentNotes(r.notes)).toHaveLength(1);
    const s = run([{ type: "parsed" }, { type: "open" }, { type: "result", result: r }]);
    expect(s.phase).toBe("opened");
  });

  it("any other secret is one unspent note, as before", async () => {
    const r = await mockOpen(SECRET);
    expect(r.all_spent).toBe(false);
    expect(r.spent_zat).toBe("0");
    expect(r.notes.every((n) => !n.spent)).toBe(true);
  });
});
