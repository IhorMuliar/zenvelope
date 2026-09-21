import { describe, expect, it } from "vitest";
import {
  FUNDS_SAFE_COPY,
  browserFamily,
  deviceLine,
  formatSeconds,
  platformName,
  stageSpan,
  timingRows,
  timingText,
  SEND_STAGES,
  STAGE_LABEL,
  SWEEP_FAILED_COPY,
  elapsedLabel,
  initialSendState,
  needsUnloadWarning,
  sendReducer,
  stageChecklist,
  sweepFailure,
  warmWaitMs,
  type SendEvent,
  type SendState,
} from "./sweepFlow";
import type { SweepResult } from "../core/types";

function run(events: SendEvent[], from: SendState = initialSendState): SendState {
  return events.reduce(sendReducer, from);
}

const OK: SweepResult = {
  txid: "a".repeat(64),
  raw_tx_hex: null,
  amount_to_destination_zat: "120000",
  fee_zat: "0",
  network_fee_zat: "10000",
  anchor_height: 3490500,
  gateway: "zjs.zec.rocks",
  broadcast: true,
  error_code: null,
  error_message: null,
};

const BROKEN: SweepResult = {
  ...OK,
  txid: "",
  error_code: 7,
  error_message: "the light node rejected the transaction",
};

const TO_SENDING: SendEvent[] = [{ type: "review" }, { type: "send", at: 1000 }];

describe("the phases", () => {
  it("starts on the choose screen", () => {
    expect(initialSendState.phase).toBe("choose");
    expect(initialSendState.done).toHaveLength(0);
  });

  it("goes choose -> review -> sending -> sent", () => {
    const state = run([...TO_SENDING, { type: "result", result: OK, at: 7000 }]);
    expect(state.phase).toBe("sent");
    expect(state.result).toBe(OK);
    expect(state.message).toBeNull();
  });

  it("goes back from review to a clean choose screen", () => {
    const state = run([{ type: "review" }, { type: "choose" }]);
    expect(state).toEqual(initialSendState);
  });

  it("cannot review from anywhere but choose", () => {
    const sending = run(TO_SENDING);
    expect(sendReducer(sending, { type: "review" })).toBe(sending);
  });

  it("cannot send twice from one press", () => {
    const sending = run(TO_SENDING);
    expect(sendReducer(sending, { type: "send", at: 2000 })).toBe(sending);
  });

  it("records when the run started, for the elapsed counter", () => {
    expect(run(TO_SENDING).startedAt).toBe(1000);
  });
});

describe("the stages", () => {
  it("marks earlier stages done as each one starts", () => {
    const state = run([
      ...TO_SENDING,
      { type: "stage", stage: "witness", detail: "tree", at: 2000 },
      { type: "stage", stage: "keys", detail: "key", at: 3000 },
      { type: "stage", stage: "proving", detail: "proof", at: 4000 },
    ]);
    expect(state.stage).toBe("proving");
    expect(state.done).toEqual(["witness", "keys"]);
    expect(state.detail).toBe("proof");
  });

  it("never walks backwards when a late stage report arrives", () => {
    const ahead = run([
      ...TO_SENDING,
      { type: "stage", stage: "proving", detail: "proof", at: 4000 },
    ]);
    const after = sendReducer(ahead, {
      type: "stage",
      stage: "witness",
      detail: "late",
      at: 5000,
    });
    expect(after).toBe(ahead);
  });

  it("finishes every stage on done", () => {
    const state = run([...TO_SENDING, { type: "stage", stage: "done", detail: "", at: 6000 }]);
    expect(state.done).toEqual([...SEND_STAGES]);
  });

  it("ignores stage reports outside a run", () => {
    const state = sendReducer(initialSendState, {
      type: "stage",
      stage: "proving",
      detail: "x",
      at: 2000,
    });
    expect(state).toBe(initialSendState);
  });

  it("builds the checklist: done, active, waiting", () => {
    const state = run([
      ...TO_SENDING,
      { type: "stage", stage: "witness", detail: "a", at: 2000 },
      { type: "stage", stage: "keys", detail: "b", at: 3000 },
    ]);
    expect(stageChecklist(state).map((r) => r.state)).toEqual([
      "done",
      "active",
      "waiting",
      "waiting",
    ]);
  });

  it("shows every line done once the result is in", () => {
    const state = run([...TO_SENDING, { type: "result", result: OK, at: 7000 }]);
    expect(stageChecklist(state).every((r) => r.state === "done")).toBe(true);
  });

  it("labels the stages in recipient words", () => {
    expect(stageChecklist(run(TO_SENDING)).map((r) => r.label)).toEqual([
      "Building the proof of ownership",
      "Preparing keys",
      "Proving (this is the slow part)",
      "Sending to the network",
    ]);
    expect(STAGE_LABEL.done).toBe("Done");
  });
});

describe("failure", () => {
  it("reads a non-zero error_code as a failure, with the core's message", () => {
    expect(sweepFailure(BROKEN)).toBe("the light node rejected the transaction");
    const state = run([...TO_SENDING, { type: "result", result: BROKEN, at: 7000 }]);
    expect(state.phase).toBe("failed");
    expect(state.message).toBe("the light node rejected the transaction");
  });

  it("treats error_code 0 and null as success", () => {
    expect(sweepFailure(OK)).toBeNull();
    expect(sweepFailure({ ...OK, error_code: 0 })).toBeNull();
  });

  it("falls back to its own copy when the core says nothing useful", () => {
    expect(sweepFailure({ ...OK, error_code: 3, error_message: null })).toBe(SWEEP_FAILED_COPY);
    expect(sweepFailure({ ...OK, error_code: 3, error_message: "  " })).toBe(SWEEP_FAILED_COPY);
  });

  it("says the money never moved", () => {
    expect(FUNDS_SAFE_COPY).toContain("still in the envelope");
  });

  it("retries straight from the error screen, with a clean slate", () => {
    const failed = run([...TO_SENDING, { type: "failed", message: "boom" }]);
    expect(failed.phase).toBe("failed");
    const again = sendReducer(failed, { type: "send", at: 9000 });
    expect(again.phase).toBe("sending");
    expect(again.done).toHaveLength(0);
    expect(again.message).toBeNull();
    expect(again.startedAt).toBe(9000);
  });

  it("can also go back and choose somewhere else after a failure", () => {
    const failed = run([...TO_SENDING, { type: "failed", message: "boom" }]);
    expect(sendReducer(failed, { type: "choose" })).toEqual(initialSendState);
  });
});

describe("leaving the page", () => {
  it("warns only while proving and broadcasting", () => {
    const at = (stage: "witness" | "keys" | "proving" | "broadcast") =>
      needsUnloadWarning(run([...TO_SENDING, { type: "stage", stage, detail: "", at: 2000 }]));
    expect(at("witness")).toBe(false);
    expect(at("keys")).toBe(false);
    expect(at("proving")).toBe(true);
    expect(at("broadcast")).toBe(true);
  });

  it("never warns before the send or after it lands", () => {
    expect(needsUnloadWarning(initialSendState)).toBe(false);
    expect(needsUnloadWarning(run([{ type: "review" }]))).toBe(false);
    expect(needsUnloadWarning(run([...TO_SENDING, { type: "result", result: OK, at: 7000 }]))).toBe(false);
    expect(
      needsUnloadWarning(run([...TO_SENDING, { type: "result", result: BROKEN, at: 7000 }])),
    ).toBe(false);
  });
});

describe("elapsed", () => {
  it("counts in m:ss", () => {
    expect(elapsedLabel(0)).toBe("0:00");
    expect(elapsedLabel(999)).toBe("0:00");
    expect(elapsedLabel(1000)).toBe("0:01");
    expect(elapsedLabel(65_400)).toBe("1:05");
    expect(elapsedLabel(600_000)).toBe("10:00");
  });

  it("never shows a negative clock", () => {
    expect(elapsedLabel(-5000)).toBe("0:00");
  });
});

/**
 * The timings behind the done screen's Timing block. Every number is wall clock
 * handed to the reducer, never read off a clock in here, so a test can say what
 * time it is and a slow machine cannot make this flaky.
 */
describe("timings", () => {
  const RUN: SendEvent[] = [
    { type: "review" },
    { type: "send", at: 1_000 },
    { type: "stage", stage: "witness", detail: "tree", at: 1_200 },
    { type: "stage", stage: "keys", detail: "key", at: 3_700 },
    { type: "stage", stage: "proving", detail: "proof", at: 4_000 },
    { type: "stage", stage: "broadcast", detail: "sending", at: 46_100 },
    { type: "stage", stage: "done", detail: "empty", at: 48_100 },
    { type: "result", result: OK, at: 48_400 },
  ];

  it("stamps every stage transition, done included", () => {
    expect(run(RUN).stageAt).toEqual({
      witness: 1_200,
      keys: 3_700,
      proving: 4_000,
      broadcast: 46_100,
      done: 48_100,
    });
  });

  it("keeps the first stamp when a stage is reported twice", () => {
    const state = run([
      ...RUN.slice(0, 3),
      { type: "stage", stage: "witness", detail: "again", at: 2_500 },
    ]);
    expect(state.stageAt.witness).toBe(1_200);
  });

  it("finishes on the result when the core never says done", () => {
    const state = run([...RUN.slice(0, 6), { type: "result", result: OK, at: 47_000 }]);
    expect(state.stageAt.done).toBe(47_000);
  });

  it("does not let the result move a done the core already reported", () => {
    expect(run(RUN).stageAt.done).toBe(48_100);
  });

  it("starts a fresh set of stamps when a failed run is tried again", () => {
    const failed = run([...RUN.slice(0, 5), { type: "failed", message: "boom" }]);
    expect(failed.stageAt.proving).toBe(4_000);
    const again = sendReducer(failed, { type: "send", at: 60_000 });
    expect(again.stageAt).toEqual({});
    expect(again.startedAt).toBe(60_000);
  });

  it("measures the span between two stages, and nothing when one is missing", () => {
    const t = run(RUN).stageAt;
    expect(stageSpan(t, "proving", "broadcast")).toBe(42_100);
    expect(stageSpan({ witness: 5 }, "witness", "keys")).toBeNull();
    // A clock that went backwards is not a negative duration, it is no duration.
    expect(stageSpan({ witness: 10, keys: 5 }, "witness", "keys")).toBeNull();
  });

  it("lays the block out in the order it happened, one decimal each", () => {
    const rows = timingRows({
      state: run(RUN),
      openMs: 4_120,
      warmMs: 30_500,
      warmDoneAt: null,
    });
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ["open/scan", "4.1 s"],
      ["keys (warm)", "30.5 s"],
      ["waiting for keys", "—"],
      ["witness", "2.5 s"],
      ["proving", "42.1 s"],
      ["send", "2.0 s"],
      ["total tap-to-done", "47.1 s"],
    ]);
  });

  it("counts the wait for the proving key only when the sweep really waited", () => {
    const state = run(RUN);
    const tap = state.startedAt!;
    // Warm-up finished before the tap: nothing was waited for.
    expect(warmWaitMs(state, tap - 1_000)).toBe(0);
    // Finished after it: the gap is the wait, and never longer than the first report.
    expect(warmWaitMs(state, tap + 200)).toBe(200);
    expect(warmWaitMs(state, tap + 10_000_000)).toBe(state.stageAt.witness! - tap);
    // Nothing known, nothing claimed.
    expect(warmWaitMs(state, null)).toBeNull();
    expect(warmWaitMs(initialSendState, 5)).toBeNull();
  });

  it("says nothing it does not know", () => {
    const rows = timingRows({
      state: run(RUN.slice(0, 3)),
      openMs: null,
      warmMs: null,
      warmDoneAt: null,
    });
    expect(rows.map((r) => r.value)).toEqual(["—", "—", "—", "—", "—", "—", "—"]);
    expect(rows.every((r) => r.ms === null)).toBe(true);
  });

  it("formats seconds to one decimal, and a dash for a non-measurement", () => {
    expect(formatSeconds(0)).toBe("0.0 s");
    expect(formatSeconds(1_940)).toBe("1.9 s");
    expect(formatSeconds(1_960)).toBe("2.0 s");
    expect(formatSeconds(125_000)).toBe("125.0 s");
    expect(formatSeconds(null)).toBe("—");
    expect(formatSeconds(-1)).toBe("—");
    expect(formatSeconds(Number.NaN)).toBe("—");
  });

  it("names the browser family, Brave included", () => {
    const safariIos =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
    const chrome =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
    const firefox = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0";
    expect(browserFamily(safariIos)).toBe("Safari");
    expect(browserFamily(chrome)).toBe("Chrome");
    expect(browserFamily(firefox)).toBe("Firefox");
    // Brave sends Chrome's user agent to the letter; only the flag tells them apart.
    expect(browserFamily(chrome, true)).toBe("Brave");
    // Playwright's own browser, which is what a measurement run reports.
    const headless =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36";
    expect(browserFamily(headless)).toBe("Chrome");
    expect(browserFamily("something else")).toBe("unknown");
  });

  it("names the platform", () => {
    expect(platformName("… (iPhone; CPU iPhone OS 17_5 like Mac OS X) …")).toBe("iOS");
    expect(platformName("… (Linux; Android 14; Pixel 8) …")).toBe("Android");
    expect(platformName("… (Macintosh; Intel Mac OS X 10_15_7) …")).toBe("macOS");
    expect(platformName("… (Windows NT 10.0; Win64; x64) …")).toBe("Windows");
    expect(platformName("… (X11; Linux x86_64) …")).toBe("Linux");
    expect(platformName("nothing recognisable")).toBe("unknown");
  });

  it("writes the device line, with a thread that is not plural", () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15";
    expect(deviceLine({ threads: 4, hardwareConcurrency: 8, userAgent: ua })).toBe(
      "proving: 4 threads · hardwareConcurrency 8 · Safari on macOS",
    );
    expect(deviceLine({ threads: 1, hardwareConcurrency: 1, userAgent: ua })).toBe(
      "proving: 1 thread · hardwareConcurrency 1 · Safari on macOS",
    );
  });

  it("names the gateway that answered, and leaves it out when there is none", () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36";
    expect(
      deviceLine({ threads: 4, hardwareConcurrency: 8, userAgent: ua, gateway: "zjs.zec.rocks" }),
    ).toBe("proving: 4 threads · hardwareConcurrency 8 · Chrome on Linux · gateway zjs.zec.rocks");
    // A core that did not say (an old wasm, or the mock before it was taught) must
    // not put an empty "gateway " on the end of a measurement.
    expect(deviceLine({ threads: 4, hardwareConcurrency: 8, userAgent: ua, gateway: "  " })).toBe(
      "proving: 4 threads · hardwareConcurrency 8 · Chrome on Linux",
    );
    expect(deviceLine({ threads: 4, hardwareConcurrency: 8, userAgent: ua })).toBe(
      "proving: 4 threads · hardwareConcurrency 8 · Chrome on Linux",
    );
  });

  it("copies as plain text, one measurement per line", () => {
    const rows = timingRows({
      state: run(RUN),
      openMs: 4_120,
      warmMs: 30_500,
      warmDoneAt: null,
    });
    expect(timingText(rows, "proving: 4 threads · hardwareConcurrency 8 · Chrome on Linux")).toBe(
      [
        "open/scan 4.1 s",
        "keys (warm) 30.5 s",
        "waiting for keys —",
        "witness 2.5 s",
        "proving 42.1 s",
        "send 2.0 s",
        "total tap-to-done 47.1 s",
        "proving: 4 threads · hardwareConcurrency 8 · Chrome on Linux",
      ].join("\n"),
    );
  });
});
