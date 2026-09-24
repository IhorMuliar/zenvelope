import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_POLL_MS,
  HIDDEN_PAUSE_MS,
  POLL_EVERY_MS,
  REORG_MARGIN,
  RESUME_MS,
  WATCH_CAP_MS,
  createPaymentWatch,
  finalLink,
  linkParts,
  toCheckResult,
  type CheckFn,
  type CheckResult,
  type WatchSnapshot,
  type WatchTarget,
} from "./paymentWatch";
import { buildCsv, type GroupEnvelope } from "./group";

const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const SECRET2 = "BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const BIRTHDAY = 3_490_400;

const target = (id: number, secret = SECRET): WatchTarget => ({ id, secret, birthday: BIRTHDAY });
const notYet = (tip: number): CheckResult => ({ paid: null, tip });
const paidAt = (height: number, zat = 130_000n): CheckResult => ({
  paid: { height, zat },
  tip: height + 1,
});

/** Lets the awaited check promises settle between timer jumps. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function setup(targets: WatchTarget[], answers: CheckFn) {
  const snaps: WatchSnapshot[] = [];
  const check = vi.fn(answers);
  const w = createPaymentWatch({ targets, check, onChange: (s) => snaps.push(s) });
  const last = () => snaps[snaps.length - 1];
  return { w, check, snaps, last };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("schedule", () => {
  it("looks first after 30 s, then every 45 s", async () => {
    const { w, check, last } = setup([target(1)], async () => notYet(BIRTHDAY + 3));
    w.start();
    expect(last().phase).toBe("waiting");
    expect(last().lastCheckedAt).toBeNull();

    await vi.advanceTimersByTimeAsync(FIRST_POLL_MS - 1);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(check).toHaveBeenCalledTimes(1);
    expect(last().phase).toBe("waiting");
    expect(last().rounds).toBe(1);

    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS - 1);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(check).toHaveBeenCalledTimes(2);
    w.dispose();
  });

  it("starts the first look at the birthday and later looks just below the last tip", async () => {
    const { w, check } = setup([target(1)], async () => notYet(BIRTHDAY + 40));
    w.start();
    await vi.advanceTimersByTimeAsync(FIRST_POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
    expect(check.mock.calls[0][1]).toBe(BIRTHDAY);
    expect(check.mock.calls[1][1]).toBe(BIRTHDAY + 40 - REORG_MARGIN);
    w.dispose();
  });

  it("never looks below the birthday, even on a short chain", async () => {
    const { w, check } = setup([target(1)], async () => notYet(BIRTHDAY + 2));
    w.start();
    await vi.advanceTimersByTimeAsync(FIRST_POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
    expect(check.mock.calls[1][1]).toBe(BIRTHDAY);
    w.dispose();
  });

  it("keeps going after a look that throws, and counts it", async () => {
    let n = 0;
    const { w, check, last } = setup([target(1)], async () => {
      n += 1;
      if (n === 1) throw new Error("both gateways down");
      return notYet(BIRTHDAY);
    });
    w.start();
    await vi.advanceTimersByTimeAsync(FIRST_POLL_MS);
    expect(last().errors).toBe(1);
    expect(last().phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
    expect(check).toHaveBeenCalledTimes(2);
    w.dispose();
  });
});

describe("found", () => {
  it("records the height and amount and stops looking", async () => {
    let n = 0;
    const { w, check, last } = setup([target(1)], async () =>
      ++n < 3 ? notYet(BIRTHDAY + n) : paidAt(BIRTHDAY + 5, 130_000n),
    );
    w.start();
    await vi.advanceTimersByTimeAsync(FIRST_POLL_MS + 2 * POLL_EVERY_MS);
    expect(check).toHaveBeenCalledTimes(3);
    expect(last().phase).toBe("done");
    expect(last().paid.get(1)).toEqual({ height: BIRTHDAY + 5, zat: 130_000n });

    await vi.advanceTimersByTimeAsync(10 * POLL_EVERY_MS);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("looks at a group one envelope at a time and skips the paid ones", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];
    const { w, check, last } = setup([target(1), target(2, SECRET2), target(3)], async (t) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(t.id);
      await new Promise((r) => setTimeout(r, 4000));
      inFlight -= 1;
      return t.id === 2 ? paidAt(BIRTHDAY + 7) : notYet(BIRTHDAY + 9);
    });
    w.start();
    await vi.advanceTimersByTimeAsync(FIRST_POLL_MS);
    expect(last().phase).toBe("checking");
    expect(last().current).toBe(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(last().current).toBe(2);
    await vi.advanceTimersByTimeAsync(8000);
    expect(last().phase).toBe("waiting");
    expect(last().paid.get(2)?.height).toBe(BIRTHDAY + 7);
    expect(maxInFlight).toBe(1);

    // The next round: envelopes 1 and 3 only, 45 s after the first one ended.
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS + 8000);
    expect(order).toEqual([1, 2, 3, 1, 3]);
    expect(check).toHaveBeenCalledTimes(5);
    w.dispose();
  });

  it("drops a result that lands after dispose", async () => {
    const { w, snaps } = setup([target(1)], async () => {
      await new Promise((r) => setTimeout(r, 1000));
      return paidAt(BIRTHDAY + 1);
    });
    w.start();
    await vi.advanceTimersByTimeAsync(FIRST_POLL_MS);
    const before = snaps.length;
    w.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(snaps.length).toBe(before);
  });
});

describe("stop after the cap", () => {
  it("gives up after two hours and looks again on restart", async () => {
    const { w, check, last } = setup([target(1)], async () => notYet(BIRTHDAY));
    w.start();
    await vi.advanceTimersByTimeAsync(WATCH_CAP_MS + POLL_EVERY_MS);
    expect(last().phase).toBe("stopped");
    const looks = check.mock.calls.length;
    // 30 s, then every 45 s up to the two-hour mark.
    expect(looks).toBe(Math.floor((WATCH_CAP_MS - FIRST_POLL_MS) / POLL_EVERY_MS) + 1);

    await vi.advanceTimersByTimeAsync(10 * POLL_EVERY_MS);
    expect(check).toHaveBeenCalledTimes(looks);

    w.restart();
    expect(last().phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(RESUME_MS);
    expect(check).toHaveBeenCalledTimes(looks + 1);
    w.dispose();
  });
});

describe("visibility", () => {
  it("keeps looking while briefly hidden", async () => {
    const { w, check } = setup([target(1)], async () => notYet(BIRTHDAY));
    w.start();
    w.setHidden(true);
    await vi.advanceTimersByTimeAsync(FIRST_POLL_MS + POLL_EVERY_MS);
    expect(check).toHaveBeenCalledTimes(2);
    w.dispose();
  });

  it("pauses when hidden too long and resumes a second after it is visible", async () => {
    const { w, check, last } = setup([target(1)], async () => notYet(BIRTHDAY));
    w.start();
    await vi.advanceTimersByTimeAsync(FIRST_POLL_MS);
    w.setHidden(true);
    await vi.advanceTimersByTimeAsync(HIDDEN_PAUSE_MS + POLL_EVERY_MS);
    expect(last().phase).toBe("paused");
    const looks = check.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(check).toHaveBeenCalledTimes(looks);

    w.setHidden(false);
    expect(last().phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(RESUME_MS);
    expect(check).toHaveBeenCalledTimes(looks + 1);
    w.dispose();
  });

  it("becoming visible does nothing while a look is already scheduled", async () => {
    const { w, check } = setup([target(1)], async () => notYet(BIRTHDAY));
    w.start();
    w.setHidden(true);
    w.setHidden(false);
    await vi.advanceTimersByTimeAsync(FIRST_POLL_MS - 1);
    expect(check).not.toHaveBeenCalled();
    w.dispose();
  });
});

describe("links", () => {
  const link = `https://zenvelope.example/e#${SECRET}.${BIRTHDAY}`;

  it("moves the birthday to the funding height and changes nothing else", () => {
    expect(finalLink(link, 3_490_472)).toBe(`https://zenvelope.example/e#${SECRET}.3490472`);
  });

  it("adds a birthday to a link that had none", () => {
    expect(finalLink(`https://zenvelope.example/e#${SECRET}`, 7)).toBe(
      `https://zenvelope.example/e#${SECRET}.7`,
    );
  });

  it("reads the secret and birthday back out", () => {
    expect(linkParts(link)).toEqual({ secret: SECRET, birthday: BIRTHDAY });
    expect(linkParts("https://zenvelope.example/e#nope")).toBeNull();
  });

  it("refuses a height that is not one", () => {
    expect(() => finalLink(link, -1)).toThrow();
    expect(() => finalLink(link, 1.5)).toThrow();
  });

  it("turns an open result into a look's answer at the lowest note height", () => {
    expect(
      toCheckResult({
        found: true,
        notes: [
          { height: 20, amount_zat: "1" },
          { height: 12, amount_zat: "2" },
        ],
        total_zat: "3",
        tip_height: 25,
      }),
    ).toEqual({ paid: { height: 12, zat: 3n }, tip: 25 });
    expect(toCheckResult({ found: false, notes: [], total_zat: "0", tip_height: 25 })).toEqual({
      paid: null,
      tip: 25,
    });
  });
});

describe("CSV with payments", () => {
  const row = (index: number, paid?: number): GroupEnvelope => {
    const link = `https://zenvelope.example/e#${SECRET}.${BIRTHDAY}`;
    return {
      index,
      link,
      address: "u1mockaddress",
      ufvk: "uview1mock",
      envelopeZat: 1_000_000n,
      envelopeZec: "0.01",
      sendZat: 1_030_000n,
      sendZec: "0.0103",
      memo: "",
      uri: "zcash:u1mockaddress?amount=0.0103",
      ...(paid === undefined ? {} : { paidHeight: paid, finalLink: finalLink(link, paid) }),
    };
  };

  it("ends every row with paid_height and final_link, empty until paid", () => {
    const lines = buildCsv([row(1, BIRTHDAY + 4), row(2)]).split("\r\n");
    expect(lines[0].split(",").slice(-2)).toEqual(["paid_height", "final_link"]);
    const paid = lines[1].split(",");
    expect(paid[7]).toBe(String(BIRTHDAY + 4));
    expect(paid[8]).toBe(`https://zenvelope.example/e#${SECRET}.${BIRTHDAY + 4}`);
    const unpaid = lines[2].split(",");
    expect(unpaid).toHaveLength(9);
    expect(unpaid[7]).toBe("");
    expect(unpaid[8]).toBe("");
  });
});
