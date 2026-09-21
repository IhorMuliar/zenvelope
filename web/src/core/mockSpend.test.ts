/**
 * The MOCK spend. It is the only thing the e2e run drives without a wasm build,
 * so its shape has to match `ZenvelopeCore` exactly, and its numbers have to be
 * the ones the review screen predicts.
 */

import { describe, expect, it } from "vitest";
import { MOCK_NOTE, MOCK_STAGE_MS, MOCK_TIP_HEIGHT, mockCore } from "./mock";
import type { SweepStage } from "./types";
import { sweepAmounts } from "../lib/amount";

const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const UA = `u1mock${"q".repeat(54)}`;
const T_ADDR = "t1KvSHRKp5ZgFcqJe8ZbeBHhpTCVCXjPWKa";
const NOTE = {
  txid: MOCK_NOTE.txid,
  height: MOCK_NOTE.height,
  action_index: MOCK_NOTE.action_index,
};

describe("warm_proving_key", () => {
  it("resolves with a duration and is safe to call twice", async () => {
    const [a, b] = await Promise.all([mockCore.warm_proving_key(), mockCore.warm_proving_key()]);
    expect(typeof a).toBe("number");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBe(a);
  }, 10_000);
});

describe("new_wallet", () => {
  it("hands back 24 words, an address and the birthday it was given", () => {
    const w = mockCore.new_wallet("main", MOCK_TIP_HEIGHT);
    expect(w.mnemonic.split(" ")).toHaveLength(24);
    expect(w.birthday).toBe(MOCK_TIP_HEIGHT);
    expect(w.address.startsWith("u1")).toBe(true);
    expect(w.address).toContain("mock");
    expect(w.ufvk).toContain("mock");
  });

  it("is a fresh wallet every time", () => {
    const a = mockCore.new_wallet("main", MOCK_TIP_HEIGHT);
    const b = mockCore.new_wallet("main", MOCK_TIP_HEIGHT);
    expect(a.mnemonic).not.toBe(b.mnemonic);
  });

  it("refuses a birthday that is not a height", () => {
    expect(() => mockCore.new_wallet("main", -1)).toThrow();
  });
});

// Concurrent: each case is a four-second wall-clock wait in the mock.
describe.concurrent("sweep_envelope", () => {
  it("reports every stage in order and ends on a 64-hex txid", async () => {
    const stages: SweepStage[] = [];
    const result = await mockCore.sweep_envelope(
      SECRET,
      "main",
      "https://example.invalid",
      NOTE,
      UA,
      "",
      "0",
      null,
      true,
      (stage) => stages.push(stage),
    );
    expect(stages).toEqual(["witness", "keys", "proving", "broadcast", "done"]);
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(result.error_code).toBeNull();
    expect(result.broadcast).toBe(true);
    expect(result.raw_tx_hex).toBeNull();
    expect(result.anchor_height).toBe(MOCK_TIP_HEIGHT);
  }, 4 * MOCK_STAGE_MS + 5000);

  it("hands back the amounts the review screen worked out", async () => {
    const result = await mockCore.sweep_envelope(
      SECRET,
      "main",
      "https://example.invalid",
      NOTE,
      UA,
      "",
      "0",
      null,
      true,
      () => {},
    );
    const expected = sweepAmounts(BigInt(MOCK_NOTE.amount_zat), "unified_orchard", 0n);
    expect(result.network_fee_zat).toBe(expected.networkFeeZat.toString());
    expect(result.fee_zat).toBe("0");
    expect(result.amount_to_destination_zat).toBe(expected.receiveZat.toString());
  }, 4 * MOCK_STAGE_MS + 5000);

  it("charges the higher miner fee for a transparent destination", async () => {
    const result = await mockCore.sweep_envelope(
      SECRET,
      "main",
      "https://example.invalid",
      NOTE,
      T_ADDR,
      "",
      "0",
      null,
      true,
      () => {},
    );
    expect(result.network_fee_zat).toBe("15000");
  }, 4 * MOCK_STAGE_MS + 5000);

  it("takes the flat fee only when there is a fee address", async () => {
    const result = await mockCore.sweep_envelope(
      SECRET,
      "main",
      "https://example.invalid",
      NOTE,
      UA,
      "u1feeaddress",
      "30000",
      null,
      true,
      () => {},
    );
    expect(result.fee_zat).toBe("30000");
    expect(result.amount_to_destination_zat).toBe("90000");
  }, 4 * MOCK_STAGE_MS + 5000);

  it("keeps the signed transaction instead of sending when asked not to broadcast", async () => {
    const result = await mockCore.sweep_envelope(
      SECRET,
      "main",
      "https://example.invalid",
      NOTE,
      UA,
      "",
      "0",
      null,
      false,
      () => {},
    );
    expect(result.broadcast).toBe(false);
    expect(result.raw_tx_hex).toMatch(/^[0-9a-f]+$/);
  }, 4 * MOCK_STAGE_MS + 5000);

  it("refuses a destination that cannot receive the note", async () => {
    await expect(
      mockCore.sweep_envelope(
        SECRET,
        "main",
        "https://example.invalid",
        NOTE,
        `zs1${"q".repeat(75)}`,
        "",
        "0",
        null,
        true,
        () => {},
      ),
    ).rejects.toThrow();
  });
});
