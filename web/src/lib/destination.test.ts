import { describe, expect, it } from "vitest";
import {
  DESTINATION_COPY,
  classifyDestination,
  classifyDestinationAsync,
  emptyDestination,
  isSendable,
} from "./destination";
import { classifyAddress } from "../core/mock";
import type { AddressClass, AddressKind, Network } from "../core/types";

/** A classifier that says whatever the test needs, so the matrix is exhaustive. */
const says =
  (kind: AddressKind, reason: string | null = null) =>
  (): AddressClass => ({ kind, reason });

const MOCK_UA = `u1mock${"q".repeat(54)}`;

describe("the destination matrix", () => {
  it("accepts a unified address with an Orchard receiver", () => {
    const s = classifyDestination("u1abc", says("unified_orchard"));
    expect(s.status).toBe("ok");
    expect(s.canContinue).toBe(true);
    expect(s.message).toBe(DESTINATION_COPY.unified_orchard);
  });

  it("accepts a transparent address, with the on-chain warning", () => {
    const s = classifyDestination("t1abc", says("transparent"));
    expect(s.status).toBe("warn");
    expect(s.canContinue).toBe(true);
    expect(s.message).toContain("this leaves the shielded pool and is visible on-chain");
  });

  it("refuses a Sapling-only address and says what to paste instead", () => {
    const s = classifyDestination("zs1abc", says("sapling"));
    expect(s.status).toBe("error");
    expect(s.canContinue).toBe(false);
    expect(s.message).toBe(
      "This address type is not supported yet, paste a unified address starting with u1.",
    );
  });

  it("refuses a unified address without an Orchard receiver", () => {
    const s = classifyDestination("u1abc", says("unified_no_orchard"));
    expect(s.status).toBe("error");
    expect(s.canContinue).toBe(false);
    expect(s.message).toContain("no Orchard receiver");
  });

  it("refuses anything else", () => {
    const s = classifyDestination("hello", says("invalid"));
    expect(s.status).toBe("error");
    expect(s.canContinue).toBe(false);
    expect(s.kind).toBe("invalid");
  });

  it("only sends to the two kinds that can receive an Ironwood note", () => {
    const sendable: AddressKind[] = ["unified_orchard", "transparent"];
    const all: AddressKind[] = [
      "unified_orchard",
      "unified_no_orchard",
      "sapling",
      "transparent",
      "invalid",
    ];
    for (const kind of all) expect(isSendable(kind)).toBe(sendable.includes(kind));
  });
});

describe("the field itself", () => {
  it("starts empty, with nothing to say and nowhere to go", () => {
    expect(emptyDestination.status).toBe("empty");
    expect(emptyDestination.message).toBeNull();
    expect(emptyDestination.canContinue).toBe(false);
  });

  it("treats whitespace as empty but keeps what was typed", () => {
    const s = classifyDestination("   ", says("invalid"));
    expect(s.status).toBe("empty");
    expect(s.input).toBe("   ");
    expect(s.kind).toBeNull();
  });

  it("trims before classifying, because a pasted address carries spaces", () => {
    let seen = "";
    const s = classifyDestination(`  ${MOCK_UA}\n`, (addr, net) => {
      seen = addr;
      return classifyAddress(addr, net);
    });
    expect(seen).toBe(MOCK_UA);
    expect(s.canContinue).toBe(true);
  });

  it("does not let a throwing classifier take the page down", () => {
    const s = classifyDestination("u1abc", () => {
      throw new Error("wasm exploded");
    });
    expect(s.kind).toBe("invalid");
    expect(s.canContinue).toBe(false);
  });

  /* ------------------------------------------------- L10: the core's reason */

  it("carries the core's reason through, instead of guessing from the prefix", () => {
    const s = classifyDestination(
      "utest1abc",
      says("invalid", "this is a Test address and the sweep is running on Main"),
    );
    expect(s.status).toBe("error");
    expect(s.reason).toBe("this is a Test address and the sweep is running on Main");
    // The product's line is unchanged: the reason is shown beside it, not folded in.
    expect(s.message).toBe(DESTINATION_COPY.invalid);
  });

  it("names a wrong-network address whatever it starts with", () => {
    // The old prefix regex knew utest1/ztestsapling1/tm/tn and nothing else, so a
    // mainnet page was silent about every other wrong-network paste.
    const s = classifyDestination(
      "u1notaprefixtheregexknew",
      says("invalid", "this is a Test address and the sweep is running on Main"),
    );
    expect(s.reason).toMatch(/Test address/);
  });

  it("says nothing extra about an address it is happy with", () => {
    expect(classifyDestination("u1abc", says("unified_orchard", "fine")).reason).toBeNull();
  });

  it("has no reason to give when the core gave none", () => {
    expect(classifyDestination("u1abc", says("invalid")).reason).toBeNull();
    expect(classifyDestination("u1abc", says("invalid", "   ")).reason).toBeNull();
  });

  it("explains a transparent address with the core's own words as well", () => {
    const s = classifyDestination("t1abc", says("transparent", "transparent P2PKH"));
    expect(s.status).toBe("warn");
    expect(s.reason).toBe("transparent P2PKH");
  });
});

describe("against the MOCK classifier", () => {
  const cases: [string, Network, AddressKind][] = [
    [MOCK_UA, "main", "unified_orchard"],
    [`u1noorchard${"q".repeat(48)}`, "main", "unified_no_orchard"],
    [`zs1${"q".repeat(75)}`, "main", "sapling"],
    ["t1KvSHRKp5ZgFcqJe8ZbeBHhpTCVCXjPWKa", "main", "transparent"],
    ["nonsense", "main", "invalid"],
    [`utest1mock${"q".repeat(54)}`, "test", "unified_orchard"],
    ["u1mockqqqqqqqqqqqqqqqqqq", "main", "invalid"], // too short to be a UA
  ];

  for (const [addr, network, kind] of cases) {
    it(`reads ${addr.slice(0, 12)} on ${network} as ${kind}`, () => {
      expect(classifyDestination(addr, classifyAddress, network).kind).toBe(kind);
    });
  }
});

describe("across the core worker", () => {
  /** The same verdict, one message round trip away. */
  const asyncSays =
    (kind: AddressKind, reason: string | null = null) =>
    async (): Promise<AddressClass> => ({ kind, reason });

  it("gives the same answer the synchronous classifier does", async () => {
    for (const kind of Object.keys(DESTINATION_COPY) as AddressKind[]) {
      const over = await classifyDestinationAsync("u1abc", asyncSays(kind));
      expect(over, kind).toEqual(classifyDestination("u1abc", says(kind)));
    }
  });

  it("short-circuits an empty field without asking the worker anything", async () => {
    let asked = 0;
    const counting = async () => {
      asked += 1;
      return { kind: "invalid", reason: null } as AddressClass;
    };
    expect(await classifyDestinationAsync("   ", counting)).toEqual({
      ...emptyDestination,
      input: "   ",
    });
    expect(asked).toBe(0);
  });

  it("treats a rejection as 'not an address' rather than taking the page down", async () => {
    const boom = () => Promise.reject(new Error("the core worker stopped unexpectedly"));
    const s = await classifyDestinationAsync("u1abc", boom);
    expect(s.kind).toBe("invalid");
    expect(s.canContinue).toBe(false);
  });

  it("carries the core's reason across the worker too", async () => {
    const s = await classifyDestinationAsync(
      "utest1abc",
      asyncSays("invalid", "this is a Test address and the sweep is running on Main"),
      "main",
    );
    expect(s.reason).toMatch(/Test address/);
  });
});
