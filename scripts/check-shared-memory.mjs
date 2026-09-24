// Assert that a wasm module imports a *shared* memory, which is what the threaded core
// build (web/src/wasm/core-mt) must do for wasm-bindgen-rayon to hand it real threads.
// CI runs this after the nightly build so a lost `--shared-memory` fails loudly.
//
//   node scripts/check-shared-memory.mjs web/src/wasm/core-mt/zenvelope_core_bg.wasm
//
// Reads the import section by hand: a memory import (kind 0x02) is followed by its
// limits, whose flag byte has bit 0x02 set when the memory is shared.
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/check-shared-memory.mjs <file.wasm>");
  process.exit(2);
}
const bytes = readFileSync(path);
let pos = 8; // magic + version

const u32 = () => {
  let result = 0;
  let shift = 0;
  for (;;) {
    const b = bytes[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return result >>> 0;
    shift += 7;
  }
};
const name = () => {
  const len = u32();
  const s = bytes.subarray(pos, pos + len).toString("utf8");
  pos += len;
  return s;
};
const limits = () => {
  const flags = bytes[pos++];
  u32(); // min
  if (flags & 0x01) u32(); // max
  return flags;
};

let found = null;
while (pos < bytes.length) {
  const id = bytes[pos++];
  const size = u32();
  const end = pos + size;
  if (id === 2) {
    const count = u32();
    for (let i = 0; i < count && !found; i++) {
      const module = name();
      const field = name();
      const kind = bytes[pos++];
      if (kind === 0x00) u32(); // function: type index
      else if (kind === 0x01) {
        pos++; // reftype
        limits();
      } else if (kind === 0x02) found = { module, field, flags: limits() };
      else if (kind === 0x03) pos += 2; // global: valtype + mutability
      else throw new Error(`unknown import kind ${kind}`);
    }
    break;
  }
  pos = end;
}

if (!found) {
  console.error(`${path}: no imported memory (was --import-memory dropped?)`);
  process.exit(1);
}
const shared = (found.flags & 0x02) !== 0;
console.log(
  `${path}: imports memory ${found.module}.${found.field}, limits flags 0x${found.flags.toString(16)}, shared=${shared}`,
);
if (!shared) process.exit(1);
