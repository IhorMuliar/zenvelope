// Smoke test: load the wasm built for `--target web` under Node and check that every
// export behaves, and that derive() reproduces the vectors in crates/core/TEST_VECTORS.md.
//
//   ./scripts/build-core.sh && node scripts/smoke-core.mjs
//
// The `web` target expects a browser, so we hand initSync the wasm bytes directly
// instead of letting the glue fetch them.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "../web/src/wasm/core");

const core = await import(resolve(pkgDir, "zenvelope_core.js"));
core.initSync({ module: await readFile(resolve(pkgDir, "zenvelope_core_bg.wasm")) });

// The fixed vector: 32 bytes 0x01..0x20.
const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString("base64url");
assert.equal(SECRET, "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA");
assert.equal(SECRET.length, 43);

const VECTORS = {
  main: {
    address:
      "u1nxx35rnvjqzuz03fcg4yur2atgm3j2yl4xsl6l93u5nxw8mxw0t5gxqlqfxruppsy7akehfj5h63j7mqx6z6uzvl0n7f3v08kszpwv4f",
    ufvk:
      "uview1xcdx66vhn75khyxkcstyeyjfg3kr59ynykc5fwnnf3pmcqtt9aszantses97lgd3gdl9a0c7ys5zhmt9hqnky49r09yhtcmm42lk8qdcy5r254xljsfnwhqmukygfxnl766l2x4svpudnvxc90gngvyc6fglx6l8j3gdhks73sxq3m6mj0gvm9csfw2tf",
  },
  test: {
    address:
      "utest1ythf7gkem8m6hna5mvvjntgvwc2rujaza72dec08azu45xdl60es6jp8h2g2693dx7afwzrz5lp9tfk43exx9ce3s38tt958pq5cxp0c",
    ufvk:
      "uviewtest1cxc75xyyvjs0ac9nvjzuu7c46aj07e3v6uh8cwhdlj9xrck5vljrkm4gl926xh5zceh3y66guf6sdkexey6980zk5r4ct6jmefdpcpj7vxfgv52g4squf3ju7e6gu963n6spvfdy9zhdpeqljwtdfejqaj9nscf02sw36z7zl9nev7z0fukjtyc5l00sd",
  },
};

let checks = 0;
const check = (label, fn) => {
  fn();
  checks += 1;
  console.log(`  ok  ${label}`);
};

console.log("derive()");
for (const [network, expected] of Object.entries(VECTORS)) {
  check(`${network} matches the Rust vector`, () => {
    const d = core.derive(SECRET, network);
    assert.equal(d.address, expected.address);
    assert.equal(d.ufvk, expected.ufvk);
    assert.equal(d.diversifier_index, 0);
  });
}
check("the address has one Orchard receiver and nothing else", () => {
  assert.equal(core.is_orchard_only(VECTORS.main.address), true);
  assert.equal(core.is_orchard_only(VECTORS.test.address), true);
});
check("an unknown network throws a string", () => {
  assert.throws(
    () => core.derive(SECRET, "mainnet"),
    (e) => typeof e === "string" && e.includes("unknown network"),
  );
});
check("a malformed secret throws a string", () => {
  assert.throws(
    () => core.derive("too-short", "main"),
    (e) => typeof e === "string",
  );
});

console.log("generate_secret()");
check("returns 43 base64url characters that derive", () => {
  const s = core.generate_secret();
  assert.equal(s.length, 43);
  assert.match(s, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(s, "base64url").length, 32);
  assert.notEqual(core.generate_secret(), s);
  assert.ok(core.derive(s, "main").address.startsWith("u1"));
});

console.log("fragments");
check("round-trip without a birthday", () => {
  const frag = core.build_fragment(SECRET);
  assert.equal(frag, SECRET);
  const parsed = core.parse_fragment(frag);
  assert.equal(parsed.secret, SECRET);
  assert.equal(parsed.birthday, undefined);
});
check("round-trip with a birthday", () => {
  const frag = core.build_fragment(SECRET, 3490400);
  assert.equal(frag, `${SECRET}.3490400`);
  const parsed = core.parse_fragment(`#${frag}`);
  assert.equal(parsed.secret, SECRET);
  assert.equal(parsed.birthday, 3490400);
});
check("a bad fragment throws a string", () => {
  assert.throws(
    () => core.parse_fragment(`${SECRET}.later`),
    (e) => typeof e === "string",
  );
});

console.log("payment_uri()");
check("accepts a BigInt, a string and a number alike", () => {
  const expected = `zcash:${VECTORS.main.address}?amount=0.0001`;
  assert.equal(core.payment_uri(VECTORS.main.address, 10000n), expected);
  assert.equal(core.payment_uri(VECTORS.main.address, "10000"), expected);
  assert.equal(core.payment_uri(VECTORS.main.address, 10000), expected);
});
check("carries the message as a base64url memo and keeps one output", () => {
  const text = "coffee & cake";
  const memo = Buffer.from(text, "utf8").toString("base64url");
  const uri = core.payment_uri(VECTORS.main.address, 100000000n, text);
  assert.equal(uri, `zcash:${VECTORS.main.address}?amount=1&memo=${memo}`);
  assert.equal(uri.split("&").length, 2);
  // A ZIP-321 message never reaches the chain, so the core does not offer one.
  assert.ok(!uri.includes("message="));
  // The memo parameter decodes back to exactly what the sender typed.
  assert.equal(Buffer.from(uri.split("&memo=")[1], "base64url").toString("utf8"), text);
});
check("rejects a memo over 512 bytes, counted in UTF-8 bytes", () => {
  assert.ok(core.payment_uri(VECTORS.main.address, 10000n, "a".repeat(512)).includes("&memo="));
  assert.throws(
    () => core.payment_uri(VECTORS.main.address, 10000n, "a".repeat(513)),
    (e) => typeof e === "string" && e.includes("513 bytes"),
  );
  assert.equal(core.max_memo_bytes(), 512);
  assert.equal(core.memo_byte_length("\u{1F381}"), 4);
});
check("rejects a zero and an over-range amount", () => {
  assert.throws(() => core.payment_uri(VECTORS.main.address, 0n), (e) => typeof e === "string");
  assert.throws(
    () => core.payment_uri(VECTORS.main.address, 2100000000000001n),
    (e) => typeof e === "string",
  );
});

console.log("amount helpers");
check("zat_to_zec_string covers the edge cases", () => {
  assert.equal(core.zat_to_zec_string(10000n), "0.0001");
  assert.equal(core.zat_to_zec_string(100000000n), "1");
  assert.equal(core.zat_to_zec_string(1234567891n), "12.34567891");
  assert.equal(core.zat_to_zec_string(150000000n), "1.5");
  assert.equal(core.zat_to_zec_string(1n), "0.00000001");
});
check("zec_string_to_zat returns a BigInt and round-trips", () => {
  assert.equal(core.zec_string_to_zat("0.0001"), 10000n);
  assert.equal(typeof core.zec_string_to_zat("1"), "bigint");
  assert.equal(core.zec_string_to_zat("12.34567891"), 1234567891n);
  assert.throws(() => core.zec_string_to_zat("1.234567891"), (e) => typeof e === "string");
});

console.log(`\n${checks} checks passed.`);
