import { describe, expect, it } from "vitest";
import {
  FUNDS_SAFE_COPY,
  SEND_STAGES,
  STAGE_LABEL,
  SWEEP_FAILED_COPY,
  elapsedLabel,
  initialSendState,
  needsUnloadWarning,
  sendReducer,
  stageChecklist,
  sweepFailure,
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
    const state = run([...TO_SENDING, { type: "result", result: OK }]);
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
      { type: "stage", stage: "witness", detail: "tree" },
      { type: "stage", stage: "keys", detail: "key" },
      { type: "stage", stage: "proving", detail: "proof" },
    ]);
    expect(state.stage).toBe("proving");
    expect(state.done).toEqual(["witness", "keys"]);
    expect(state.detail).toBe("proof");
  });

  it("never walks backwards when a late stage report arrives", () => {
    const ahead = run([
      ...TO_SENDING,
      { type: "stage", stage: "proving", detail: "proof" },
    ]);
    const after = sendReducer(ahead, { type: "stage", stage: "witness", detail: "late" });
    expect(after).toBe(ahead);
  });

  it("finishes every stage on done", () => {
    const state = run([...TO_SENDING, { type: "stage", stage: "done", detail: "" }]);
    expect(state.done).toEqual([...SEND_STAGES]);
  });

  it("ignores stage reports outside a run", () => {
    const state = sendReducer(initialSendState, {
      type: "stage",
      stage: "proving",
      detail: "x",
    });
    expect(state).toBe(initialSendState);
  });

  it("builds the checklist: done, active, waiting", () => {
    const state = run([
      ...TO_SENDING,
      { type: "stage", stage: "witness", detail: "a" },
      { type: "stage", stage: "keys", detail: "b" },
    ]);
    expect(stageChecklist(state).map((r) => r.state)).toEqual([
      "done",
      "active",
      "waiting",
      "waiting",
    ]);
  });

  it("shows every line done once the result is in", () => {
    const state = run([...TO_SENDING, { type: "result", result: OK }]);
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
    const state = run([...TO_SENDING, { type: "result", result: BROKEN }]);
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
      needsUnloadWarning(run([...TO_SENDING, { type: "stage", stage, detail: "" }]));
    expect(at("witness")).toBe(false);
    expect(at("keys")).toBe(false);
    expect(at("proving")).toBe(true);
    expect(at("broadcast")).toBe(true);
  });

  it("never warns before the send or after it lands", () => {
    expect(needsUnloadWarning(initialSendState)).toBe(false);
    expect(needsUnloadWarning(run([{ type: "review" }]))).toBe(false);
    expect(needsUnloadWarning(run([...TO_SENDING, { type: "result", result: OK }]))).toBe(false);
    expect(
      needsUnloadWarning(run([...TO_SENDING, { type: "result", result: BROKEN }])),
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
