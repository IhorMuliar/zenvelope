/**
 * The private mainnet fixtures, read at run time and never printed.
 *
 * Each fragment comes from its environment variable when that is set. Otherwise,
 * when `ZENV_FIXTURE_DIR` names the directory holding the private, gitignored
 * M1-FUND.md and M3-DEST.md, it is read out of those files. With neither, the
 * value is undefined and the spec that needs it skips — which is what CI and a
 * fresh checkout see.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** `<43 base64url chars>.<birthday>` after an `e#`, as the private files write links. */
const LINK_FRAGMENT = /e#([A-Za-z0-9_-]{43}\.\d+)/;

function fromFile(name: string): string | undefined {
  const dir = process.env.ZENV_FIXTURE_DIR;
  if (!dir) return undefined;
  const path = resolve(dir, name);
  if (!existsSync(path)) return undefined;
  return LINK_FRAGMENT.exec(readFileSync(path, "utf8"))?.[1];
}

/**
 * The day-one M1 envelope: funded with 130,000 zatoshi at block 3,490,472 and
 * swept in tx ba0f91cf… at block 3,491,056. Empty now, which is what makes it
 * the fixture for the "already opened" screen.
 */
export function sweptM1Fragment(): string | undefined {
  return process.env.ZENV_SWEPT_FRAGMENT?.trim() || fromFile("M1-FUND.md");
}

/** The fee envelope from M3-DEST.md: 30,000 zatoshi, unspent. */
export function feeEnvelopeFragment(): string | undefined {
  return process.env.ZENV_FEE_FRAGMENT?.trim() || fromFile("M3-DEST.md");
}
