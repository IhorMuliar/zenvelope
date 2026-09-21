/**
 * Group envelopes, across the core worker.
 *
 * `generateGroup` is asynchronous from M4 on, because every derivation is a message
 * round trip. These drive it through the *real* RPC client (`createCoreClient`) over the
 * fake worker from `src/core/fakeWorker.ts`, with the MOCK core answering on the far
 * side — so what is under test is the same promise-per-call surface the page holds, not
 * a stub that happens to be `async`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { createCoreClient } from "../core/client";
import { coreBackedWorker } from "../core/fakeWorker";
import type { LoadedCore } from "../core/types";
import {
  CSV_COLUMNS,
  MAX_ENVELOPES,
  buildCsv,
  csvCell,
  csvFilename,
  generateGroup,
  groupTotal,
  validateCount,
  zecMultiple,
  type GroupEnvelope,
} from "./group";

const REQ = {
  count: 3,
  envelopeZat: 1_000_000n, // 0.01 ZEC
  feeZat: 30_000n, // 0.0003 ZEC
  message: "Thanks for shipping",
  network: "main" as const,
  birthday: 3_490_500,
  origin: "https://zenvelope.example",
};

/** The MOCK core, reached exactly as the page reaches it: over the worker protocol. */
let core: LoadedCore;
beforeAll(async () => {
  core = await createCoreClient(coreBackedWorker(), { maxThreads: 1 });
});

describe("validateCount", () => {
  it("takes 1 through 50", () => {
    expect(validateCount("1")).toEqual({ ok: true, count: 1 });
    expect(validateCount(" 50 ")).toEqual({ ok: true, count: 50 });
    expect(validateCount("7")).toEqual({ ok: true, count: 7 });
  });

  it("refuses nothing, fractions, zero and more than the limit", () => {
    for (const bad of ["", "  ", "0", "-3", "2.5", "3e2", "fifty", "51", "1000"]) {
      const r = validateCount(bad);
      expect(r.ok, `"${bad}" should not validate`).toBe(false);
    }
  });

  it("says the limit out loud when it is exceeded", () => {
    const r = validateCount("51");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(String(MAX_ENVELOPES));
  });
});

describe("generateGroup over the core worker", () => {
  it("makes N envelopes, numbered from 1", async () => {
    const rows = await generateGroup(core, REQ);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.index)).toEqual([1, 2, 3]);
  });

  it("gives every envelope its own secret, link and address", async () => {
    const rows = await generateGroup(core, { ...REQ, count: 12 });
    expect(new Set(rows.map((r) => r.link)).size).toBe(12);
    expect(new Set(rows.map((r) => r.address)).size).toBe(12);
    expect(new Set(rows.map((r) => r.uri)).size).toBe(12);
  });

  it("reports progress one envelope at a time, in order", async () => {
    const seen: Array<[number, number]> = [];
    const rows = await generateGroup(core, { ...REQ, count: 4 }, (made, total) =>
      seen.push([made, total]),
    );
    expect(rows).toHaveLength(4);
    expect(seen).toEqual([
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4],
    ]);
  });

  it("puts the secret in the fragment, with the birthday, and nowhere else", async () => {
    const rows = await generateGroup(core, REQ);
    for (const r of rows) {
      const [base, fragment] = r.link.split("#");
      expect(base).toBe("https://zenvelope.example/e");
      expect(fragment).toMatch(/^[A-Za-z0-9_-]{43}\.3490500$/);
      // The secret is in the link and in nothing else the row carries.
      const secret = fragment.split(".")[0];
      expect(r.address).not.toContain(secret);
      expect(r.ufvk).not.toContain(secret);
      expect(r.uri).not.toContain(secret);
    }
  });

  it("charges the same amount for each: envelope plus the flat fee", async () => {
    const rows = await generateGroup(core, REQ);
    for (const r of rows) {
      expect(r.amountZat).toBe(1_030_000n);
      expect(r.amount).toBe("0.0103");
      expect(r.uri).toContain("amount=0.0103");
    }
    expect(groupTotal(rows)).toBe("0.0309");
  });

  it("builds a single-output ZIP-321 URI per envelope, with the message in memo=", async () => {
    const rows = await generateGroup(core, REQ);
    for (const r of rows) {
      expect(r.uri.startsWith(`zcash:${r.address}?`)).toBe(true);
      expect(r.uri).toContain("&memo=");
      // Single output: no ZIP-321 index suffixes anywhere.
      expect(r.uri).not.toMatch(/address\.\d/);
      expect(r.memo).toBe("Thanks for shipping");
    }
  });

  it("leaves memo= out when there is no message", async () => {
    const rows = await generateGroup(core, { ...REQ, message: "" });
    expect(rows[0].uri).not.toContain("memo=");
    expect(rows[0].memo).toBe("");
  });

  it("omits the birthday when the chain height was unavailable", async () => {
    const rows = await generateGroup(core, { ...REQ, birthday: undefined });
    expect(rows[0].link.split("#")[1]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("makes one envelope for a group of one, so N=1 is not a special case", async () => {
    const rows = await generateGroup(core, { ...REQ, count: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].index).toBe(1);
  });

  it("makes the full 50", async () => {
    const rows = await generateGroup(core, { ...REQ, count: MAX_ENVELOPES });
    expect(rows).toHaveLength(50);
    expect(new Set(rows.map((r) => r.link)).size).toBe(50);
  });

  it("refuses a count outside the range and a non-positive amount", async () => {
    await expect(generateGroup(core, { ...REQ, count: 0 })).rejects.toThrow(/1 to 50/);
    await expect(generateGroup(core, { ...REQ, count: 51 })).rejects.toThrow(/1 to 50/);
    await expect(generateGroup(core, { ...REQ, envelopeZat: 0n })).rejects.toThrow(/positive/);
  });

  it("surfaces a worker that fails rather than making half a group", async () => {
    const broken = {
      ...core,
      generate_secret: () => Promise.reject(new Error("the core worker stopped unexpectedly")),
    };
    await expect(generateGroup(broken, REQ)).rejects.toThrow(/stopped unexpectedly/);
  });
});

describe("csvCell", () => {
  it("leaves an ordinary value alone", () => {
    expect(csvCell("1")).toBe("1");
    expect(csvCell("0.0103")).toBe("0.0103");
    expect(csvCell("https://zenvelope.example/e#abc")).toBe("https://zenvelope.example/e#abc");
  });

  it("quotes a comma, a quote or a newline, RFC 4180 style", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("two\r\nlines")).toBe('"two\r\nlines"');
  });

  it("neutralises a cell a spreadsheet would run as a formula", () => {
    // The memo is text a stranger typed. CSV injection is a real attack on the
    // person who opens the file, not on us.
    expect(csvCell("=1+1")).toBe("\"'=1+1\"");
    expect(csvCell("+41 555")).toBe("\"'+41 555\"");
    expect(csvCell("-3")).toBe("\"'-3\"");
    expect(csvCell("@SUM(A1)")).toBe("\"'@SUM(A1)\"");
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(
      "\"'=HYPERLINK(\"\"http://evil\"\",\"\"x\"\")\"",
    );
  });

  it("does not touch a formula character in the middle of a value", () => {
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell("zcash:u1abc?amount=0.01")).toBe("zcash:u1abc?amount=0.01");
  });

  it("handles an empty cell", () => {
    expect(csvCell("")).toBe("");
  });
});

describe("buildCsv", () => {
  let rows: GroupEnvelope[];
  let csv: string;
  let lines: string[];

  beforeAll(async () => {
    rows = await generateGroup(core, REQ);
    csv = buildCsv(rows);
    lines = csv.split("\r\n");
  });

  it("starts with the documented header, in order", () => {
    expect(lines[0]).toBe("index,link,address,amount,memo,payment_uri");
    expect(CSV_COLUMNS).toHaveLength(6);
  });

  it("has one row per envelope and a trailing CRLF", () => {
    expect(lines).toHaveLength(rows.length + 2); // header + 3 rows + the final ""
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(lines[lines.length - 1]).toBe("");
  });

  it("carries every field of every envelope", () => {
    rows.forEach((r, i) => {
      const cells = lines[i + 1].split(",");
      expect(cells[0]).toBe(String(r.index));
      expect(cells[1]).toBe(r.link);
      expect(cells[2]).toBe(r.address);
      expect(cells[3]).toBe(r.amount);
      expect(cells[4]).toBe(r.memo);
      expect(lines[i + 1]).toContain(r.uri);
    });
  });

  it("quotes a memo with a comma in it rather than breaking the row", async () => {
    const tricky = await generateGroup(core, {
      ...REQ,
      count: 1,
      message: 'Payroll, March, "final"',
    });
    const line = buildCsv(tricky).split("\r\n")[1];
    expect(line).toContain('"Payroll, March, ""final"""');
    // Still well formed once the quoting is honoured.
    expect(line.match(/(^|,)"/g)?.length).toBeGreaterThan(0);
  });

  it("keeps the viewing key out of the file", () => {
    for (const r of rows) expect(csv).not.toContain(r.ufvk);
  });

  it("is empty but well formed for no rows", () => {
    expect(buildCsv([])).toBe("index,link,address,amount,memo,payment_uri\r\n");
  });

  it("does not contain the word this product never uses", () => {
    expect(csv.toLowerCase()).not.toContain("claim");
  });
});

describe("csvFilename", () => {
  it("names the file by count and date, with no secret in it", () => {
    const name = csvFilename(3, new Date(2026, 8, 21));
    expect(name).toBe("zenvelope-3-envelopes-2026-09-21.csv");
    expect(name).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });
});

describe("groupTotal", () => {
  it("sums in zatoshi, never in floating point", () => {
    const rows: GroupEnvelope[] = Array.from({ length: 3 }, (_, i) => ({
      index: i + 1,
      link: "",
      address: "",
      ufvk: "",
      amountZat: 10_000_003n,
      amount: "0.10000003",
      memo: "",
      uri: "",
    }));
    expect(groupTotal(rows)).toBe("0.30000009");
  });
});

describe("zecMultiple", () => {
  it("multiplies in zatoshi, for the running total on the form", () => {
    expect(zecMultiple(1_030_000n, 3)).toBe("0.0309");
    expect(zecMultiple(1_030_000n, 50)).toBe("0.515");
    expect(zecMultiple(1_030_000n, 1)).toBe("0.0103");
    expect(zecMultiple(1_030_000n, 0)).toBe("0");
  });
});
