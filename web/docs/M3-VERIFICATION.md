# M3 verification

Evidence that a browser **spends** a real, funded mainnet envelope: the /e page derives
the spending key from the link fragment alone, witnesses the envelope's Ironwood note
against the chain's own commitment tree, builds a two-action V6 transaction and **proves
it in WASM** — through the product's own screens, not a test harness.

**Sections 1–7 were dry runs.** Every run recorded there took the dry-run path and passed
`broadcast: false` to `sweep_envelope`, and at the time they were written the money was
still in the M1 envelope. Sending it was a separate step, triggered by hand on the same
day: it is [§9, Broadcast, verified](#9-broadcast-verified) — tx
`ba0f91cfe7…6260fa2aad`, block **3,491,056**, 0.0009 ZEC delivered. The M1 envelope is
now empty and its link no longer holds anything.

Run on 2026-09-21. Everything below is a transcript of commands that were actually
executed, not a description of what they would do.

- Repo: `/root/Projects/web3-sweep/zenvelope`, branch `main`
- Network: **mainnet** throughout
- Envelope under test: the one funded for M1 (tx `281e9f7b…341d43`, block 3,490,472,
  130,000 zatoshi = 0.0013 ZEC, one Ironwood note at **action index 1**). Its link
  fragment is the money, so it is not in this repo: it lives in the gitignored
  `M1-FUND.md`, is passed in as `ZENV_M1_FRAGMENT`, and is never printed, logged or
  committed. The destination wallet and the fee envelope live in the gitignored
  `M3-DEST.md` the same way.

## 1. The build

```sh
./scripts/build-core.sh
cargo test -p zenvelope-core
node scripts/smoke-core.mjs
cd web && npm ci && npm test && npm run build
```

| | |
| --- | --- |
| wasm, raw | **2,231,657 bytes** (2,179 KB) |
| wasm, gzip | 1,055,444 bytes (1,030 KB) |
| wasm-pack | 0.13.1, `--target web --release`, `wasm-opt` on |
| `cargo test -p zenvelope-core` | **72 passed**, 0 failed, 2 ignored (+ 1 passed, 3 ignored in `tests/m3_sweep.rs`) |
| `node scripts/smoke-core.mjs` | **17 checks passed** |
| `npm test` (vitest) | **151 passed** in 10 files |
| `npm run build` | `tsc -b && vite build`, clean |

The prover is what grew the wasm: 788,781 bytes at M2 (derivation plus the scanner) to
2,231,657 bytes here. The Orchard/Ironwood halo2 circuit is nearly all of the difference.
Sapling proving *parameters* are still never downloaded — see `NoSaplingProver` in
[crates/core/README.md](../../crates/core/README.md).

```
dist/assets/zenvelope_core_bg-_7xvRzdF.wasm  2,231.66 kB
dist/assets/zenvelope_core-CmEyHIQ2.js          24.89 kB │ gzip:  6.48 kB
dist/assets/index-BoxK-OAT.js                  212.38 kB │ gzip: 70.45 kB
```

## 2. Interface: the real exports against the TypeScript contract

The M3 core and the M3 UI were written in parallel and merged. The merge resolved
`web/src/core/mock.ts`, `web/src/core/types.ts` and `web/src/lib/openFlow.test.ts` toward
the UI branch, dropping the core branch's edits to them, so every field of
`web/src/core/types.ts` and every wrapper in `web/src/core/index.ts` was re-checked
against the generated `web/src/wasm/core/zenvelope_core.d.ts` and against
`crates/core/src/grpc.rs`.

One real mismatch, and it was the one that matters:

| | Contract said | The chain says | Fix |
| --- | --- | --- | --- |
| `notes[].action_index` for the M1 note | `0` | **`1`** — the sending wallet took its own change in action 0 of the same Ironwood bundle | restored `1` in `mock.ts`, `openFlow.test.ts`; `mockSpend.test.ts` now follows `MOCK_NOTE.action_index` rather than repeating a literal |

A wrong `action_index` is not cosmetic: `sweep_envelope` re-derives the note by decrypting
`ironwood_actions[action_index]` of the funding transaction, so pointing it at action 0
would fail to decrypt and the sweep would refuse to build. The value is pinned in three
places that now agree: the native integration test, `e2e/m3-core.spec.ts`, and the mock.

Everything else already matched, and was verified item by item:

| Checked | Result |
| --- | --- |
| `sweep_envelope` argument order and arity | 10 arguments: `secret, network, lightwalletd_url, note, destination, fee_address, fee_zat, memo, broadcast, on_stage` — matches `grpc.rs` and the `.d.ts` |
| `on_stage` shape | `(stage, detail) => void`, `Option<Function>` on the Rust side, and anything it throws is ignored |
| Amounts | `amount_to_destination_zat`, `fee_zat`, `network_fee_zat`, `total_zat`, `amount_zat` all cross as **decimal strings** and are parsed with `BigInt`, never an `f64` |
| `fee_zat` in | a decimal string; `"0"` builds one output and never reads `fee_address` |
| `error_code` / `error_message` | present on the result, `null` when `broadcast` was false; `sweepFailure()` treats `null` and `0` as success |
| `raw_tx_hex` | `string` when `broadcast` was false, `null` when it was true |
| Memory | `derive`, `parse_fragment`, `classify_address` and `new_wallet` return wasm-bindgen structs, and `index.ts` copies their fields and calls `free()`; `open_envelope` and `sweep_envelope` resolve with plain JS objects, where the `free()` call is a no-op |
| Errors | every export rejects or throws a **plain string**, not an `Error` |

**The MOCK badge does not appear when the real wasm is present.** `web/src/core/index.ts`
falls back to the mock only when `import.meta.glob` finds no build, so `core.isMock` is
false and no badge is rendered. `e2e/m3-real.spec.ts` asserts `mock-badge` has count 0
both before and after the envelope opens, and the three MOCK flow tests in
`e2e/m3-open.spec.ts` skip themselves when a build is present.

## 3. The dry-run switch

`?dry=1` in the **query string** — never the fragment, which is the money — makes
`SendOn` pass `broadcast: false`. The done screen then says
`Dry run: transaction built and proved, not sent`, shows the size of the transaction it
built instead of a block-explorer link, and says the envelope still holds the money
rather than that it is empty. The flag is read once at mount from
`window.location.search`, so nothing can flip it under a sweep that is already running,
and `src/lib/dryRun.test.ts` pins that a fragment containing the text `?dry=1` does not
switch it on.

The flat fee needs a real address to pay, and that address is private. `FEE_ADDRESS` in
`web/src/config.ts` therefore reads `import.meta.env.VITE_FEE_ADDRESS` with the committed
constant (`""`) as the fallback, so this run could prove the **two-output** sweep without
the fee envelope's address entering the repository. With the variable unset, the constant
stands and the open flow passes `fee_zat: "0"` and shows no fee line, exactly as before.

## 4. The real sweep, through the UI, on mainnet

```
✓ 16 e2e/m3-real.spec.ts › pastes a Zcash address, reviews, sends, and lands on the dry-run screen (1.4m)
✓ 17 e2e/m3-real.spec.ts › generates a wallet in the browser and sweeps to it, dry run (1.4m)
```

Playwright's own chromium against the production build served by `vite preview` with the
production COOP/COEP headers. Not the CDP browser on port 9222.

### What the page showed

| | Review screen | Done screen |
| --- | --- | --- |
| In the envelope | `0.0013 ZEC` | — |
| Network fee (ZIP-317, 2 actions) | `0.0001 ZEC` | — |
| Zenvelope fee (D5, second output) | `0.0003 ZEC` | — |
| You receive | **`0.0009 ZEC`** | `0.0009 ZEC` |
| Heading | `Check this over` | `Dry run complete.` |
| Dry-run line | — | `Dry run: transaction built and proved, not sent` |
| Raw transaction | — | **`9,166 bytes`** |
| Explorer link | — | **absent** |
| Envelope | — | `Nothing was sent. The money is still in the envelope, and this link still works.` |
| MOCK badge | absent | absent |
| Drainer copy | the word "claim" appears nowhere in the body | same |

Screenshots: [m3-review-real.png](m3-review-real.png),
[m3-done-dry.png](m3-done-dry.png).

The page also asserted that the link secret appears in **no request URL**, that
`localStorage` and `sessionStorage` are both `{}` at the end of both runs, and that no
page error was raised.

### Timing

| | Pasted address | New wallet |
| --- | --- | --- |
| "Send it on" tapped → done screen | **48.9 s** | **47.3 s** |
| Raw transaction | 9,166 bytes | 9,166 bytes |

Both figures are with the Ironwood proving key **already warm**: `warm_proving_key()`
starts the moment the envelope opens, and the page waits for "Keys ready" before a
destination is even chosen. That is the whole point of warming it — the key build happens
while the recipient reads, not while they wait.

### Per stage

The stage callbacks are timed at the source in `e2e/m3-core.spec.ts`, which drives the
same wasm with the same note, destination and fee address, in the same browser, and also
with `broadcast: false`:

```
M3 browser sweep: proving key 29.0 s (second call 0 ms), sweep 49.0 s, total 78.2 s,
  raw tx 9166 bytes, anchor 3490587, txid 12d3080618679f79cfbdaee07100de5838041d361083a16533a6d4477a184a3d
M3 stages: witness -> witness -> witness -> keys -> proving -> broadcast -> done
M3 stage timings: witness 6.2 s, witness 0.7 s, witness 0.0 s, keys 0.1 s,
  proving 42.0 s, broadcast 0.0 s, done 0.0 s
```

| Stage | Wall time | What it is |
| --- | --- | --- |
| `warm_proving_key` (background) | **29.0 s**, second call **0 ms** | the Orchard/Ironwood proving key, built once per page |
| `witness` | **6.9 s** total over three reports | `GetTreeState(h−1)`, the replay of block 3,490,472's Ironwood commitments, and the walk forward to the anchor |
| `keys` | 0.1 s | ZIP-32 from the link secret to the spend authorizing key |
| `proving` | **42.0 s** | one Ironwood spend proof, single-threaded wasm |
| `broadcast` | 0.0 s | **skipped: broadcast was not requested** |
| total sweep | **49.0 s** | with the key already warm |

Anchor height 3,490,587 — the chain tip at the time, not the note's own block, because
the envelope was 115 blocks old. (The constant was then `ANCHOR_WALK_LIMIT`, 1,500 blocks.
It is now `ANCHOR_WALK_CAP`, 120 blocks, and the anchor is `min(tip, newest note + cap)`;
this run was inside the cap too, so the same height comes out. See DECISIONS.md D18.)

### A finding: single-threaded proving freezes the progress screen

The four-stage checklist paints `witness` and then nothing until the done screen replaces
it, and the elapsed clock stops with it. This is not a flake and not a bug in the UI.
`crates/core/src/sweep.rs` reports `keys`, then `proving`, and then calls
`build_and_prove`, and there is **no `.await` anywhere between the three**: single-threaded
wasm proving holds the browser's main thread for the whole 42 s, so no render can be
scheduled and no timer can fire until `sweep_envelope` resolves. The callbacks themselves
all fire, in the documented order — `m3-core.spec.ts` records every one — but the DOM
never sees them.

`e2e/m3-real.spec.ts` therefore asserts what a recipient actually sees: that the painted
stages are in the documented order and begin with `witness`, and that the run lands on the
dry-run done screen. Making the other three visible needs the prover off the main thread,
which is the M4 threaded-proving spike, not a copy change.

## 5. The new-wallet path

The second test takes "A new wallet in this browser" instead of a pasted address:
`new_wallet(network, tipHeight)` generates 24 BIP-39 words in the page, the checkbox
gate ("I wrote these down") is asserted to be closed and then opened, and the sweep runs
to the same dry-run done screen with the same numbers and the same 9,166 bytes.

The wallet generated on the run recorded here:

```
u15wltw5v8hkthcqtdejrtc8vhf7z58rgk2e84ckaf4nx2azdn8979d0qja0w5cqycrwat4pmtxsp8m7a0vr8mryj4zcljz9lpwvs0fesw
```

That is the **address** only. The mnemonic is the money: it exists on the screen and in
one piece of React state, it is read by nothing, and it is not recorded here or anywhere
else. A fresh wallet is generated on every run, so this address is a record of what
happened, not something to pay.

## 6. Nothing was broadcast in §1–5

- The page was loaded with `?dry=1`, so `SendOn` passed `broadcast: false`.
- The core's own result says so, and the test asserts it through the UI: the done screen
  is the dry-run screen, there is no explorer link, and `raw_tx_hex` is present — which
  `crates/core` only ever returns when the transaction was **not** sent.
- `e2e/m3-core.spec.ts` asserts `result.broadcast === false`, `error_code === null` and
  `error_message === null`.
- The native integration test (`cargo test -p zenvelope-core --test m3_sweep -- --ignored`)
  is `broadcast: false` as well.
- The M1 envelope still held its 130,000 zatoshi when this section was written, and the
  link in `M1-FUND.md` still opened it.

Broadcasting the real sweep was a separate step, triggered by hand by the owner. It
happened later the same day, and it is [§9](#9-broadcast-verified): the envelope is empty
now, and everything above is the evidence that was in hand before it was spent.

## 7. Nothing regressed

The whole suite, with the real wasm present:

```
Running 17 tests using 1 worker
  ✓   1 e2e/m1.spec.ts › serves the wasm cross-origin isolated (609ms)
  ✓   2 e2e/m1.spec.ts › creates an envelope and re-derives it from the link (2.3s)
  ✓   3 e2e/m1.spec.ts › derives the documented address for the fixed test vector (695ms)
M2 scan: 151 blocks (3490437..3490587) in 3.9 s, 3 progress callbacks, last [151,151]
  ✓   4 e2e/m2-core.spec.ts › finds the Ironwood note the oracle sees (4.3s)
  ✓   5 e2e/m2-core.spec.ts › rejects a malformed secret without touching the network (356ms)
  -   6..8 e2e/m2-open.spec.ts › the MOCK group (skipped: a real wasm build is present)
M2 open page: 151 blocks (3490437..3490587) in 33.9 s
  ✓   9 e2e/m2-open.spec.ts › opens it in the browser and shows the real amount (35.1s)
  ✓  10 e2e/m3-core.spec.ts › warms the proving key and proves a 2-action Ironwood sweep (1.3m)
  ✓  11 e2e/m3-core.spec.ts › refuses a Sapling destination before touching the network (313ms)
  ✓  12 e2e/m3-core.spec.ts › generates a wallet a recipient can import (481ms)
  -  13..15 e2e/m3-open.spec.ts › the MOCK group (skipped: a real wasm build is present)
  ✓  16 e2e/m3-real.spec.ts › pastes a Zcash address, reviews, sends, dry-run screen (1.4m)
  ✓  17 e2e/m3-real.spec.ts › generates a wallet in the browser and sweeps to it (1.4m)

  6 skipped
  11 passed (4.9m)
```

The six skips are the two MOCK flow groups, which skip themselves precisely because the
real core is present; they are what a checkout with no wasm build runs.

One number moved: the `/e` page took **33.9 s** to scan 151 blocks where the bare page
took **3.9 s** for the same range. M2 measured 2.4 s against 2.0 s for a 64-block range.
The scan itself is the same code, so the spread is the public gateway's, as M2 already
warned; the honest budget for the open flow is still "a few seconds for a fresh link,
sometimes much worse", and it is worth re-measuring before the demo video.

## 8. Exact commands

```sh
# from the repo root
./scripts/build-core.sh
cargo test -p zenvelope-core
node scripts/smoke-core.mjs

cd web
npm ci
npm test

# The fragment, the destination and the fee address are the money, so they are read
# from the private, gitignored M1-FUND.md and M3-DEST.md at run time, never echoed
# and never committed. VITE_FEE_ADDRESS has to be set for the BUILD as well as for
# the run: Vite bakes it into config.ts at build time.
export ZENV_M1_FRAGMENT="$(grep -m1 -oP '(?<=/e#)[A-Za-z0-9_.-]+' ../M1-FUND.md)"
export ZENV_M3_DEST_ADDRESS="$(grep -oP "(?<=export ZENV_M3_DEST_ADDRESS=')[^']+" ../M3-DEST.md)"
export ZENV_M3_FEE_ADDRESS="$(grep -oP "(?<=export ZENV_M3_FEE_ADDRESS=')[^']+" ../M3-DEST.md)"
export VITE_FEE_ADDRESS="$ZENV_M3_FEE_ADDRESS"

npm run build
npx playwright test                       # everything, as transcribed in §7
npx playwright test e2e/m3-real.spec.ts   # just the UI dry run, §4 and §5

# and the MOCK flow groups, which is what a checkout with no wasm build runs:
mv src/wasm /tmp/wasm-stash && npm run e2e; mv /tmp/wasm-stash src/wasm
```

Both paths were run for this document. With the wasm present: **11 passed, 6 skipped**
(§7). With it absent and the three environment variables unset: **6 passed, 11 skipped** —
the MOCK groups in `m2-open.spec.ts` and `m3-open.spec.ts`, including the mock's own
"Sent." screen with its block-explorer link, which is the non-dry path and is unchanged
by this milestone.

`e2e/m3-real.spec.ts` skips itself cleanly when `ZENV_M1_FRAGMENT`,
`ZENV_M3_DEST_ADDRESS` or `VITE_FEE_ADDRESS` is missing, which is what CI and a fresh
checkout see. None of the three is ever written to the repository: `M1-FUND.md` and
`M3-DEST.md` are gitignored, `dist/` is gitignored, and the built bundle that carries the
fee address is never committed.

## 9. Broadcast, verified

On **2026-09-21**, with the owner's explicit approval, the same flow was run once more
through the production build **without `?dry=1`**. The transaction was signed, proved and
**sent**. This section is the transcript.

| | |
| --- | --- |
| txid | **`ba0f91cfe7ca33dd269b692bf80027df2681a321215e90ab28c2a56260fa2aad`** |
| explorer | https://mainnet.zcashexplorer.app/transactions/ba0f91cfe7ca33dd269b692bf80027df2681a321215e90ab28c2a56260fa2aad |
| mined in block | **3,491,056**, 2026-09-21 11:13:16 UTC |
| inputs | the M1 envelope's one Ironwood note, 130,000 zat (tx `281e9f7b…341d43`, block 3,490,472, action index 1) |
| outputs | 90,000 zat to the destination wallet, 30,000 zat to the fee envelope, both Ironwood |
| network fee | 10,000 zat (ZIP-317, two actions) |
| proving | `proving: 4 threads` — the threaded wasm package, in the core worker |

### The run

Playwright's own chromium (not the CDP browser on 9222), viewport 1280×720, video
recording on, against `npm run preview` on port 4207 with the production COOP/COEP
headers, on the build made with `VITE_FEE_ADDRESS` set to the fee envelope's address.

| Moment | UTC |
| --- | --- |
| `/e#<fragment>` loaded, no query string | 11:11:20.3 |
| envelope open, `0.0013 ZEC` on screen | 11:11:35.0 (14.2 s) |
| `Keys ready` — `warm_proving_key` done in the background | 11:11:49.9 (14.9 s after the reveal) |
| destination pasted, review shown | 11:11:50.1 |
| **"Send it on" tapped** | **11:11:50.4** |
| **Done screen: `Sent.`** | **11:12:30.6** |
| the transaction is in a block | 11:13:16 (block 3,491,056) |

### What the page showed

| | Review screen | Done screen |
| --- | --- | --- |
| In the envelope | `0.0013 ZEC` | — |
| Network fee (ZIP-317, 2 actions) | `0.0001 ZEC` | — |
| Zenvelope fee (D5, second output) | `0.0003 ZEC` | — |
| You receive | **`0.0009 ZEC`** | `0.0009 ZEC` |
| Heading | `Check this over` | **`Sent.`** |
| Transaction | — | `ba0f91cfe7…6260fa2aad` |
| Explorer link | — | **present**, to zcashexplorer.app |
| Dry-run line | — | **absent** |
| Envelope | — | **`The envelope is now empty.`** |
| Footer | `proving: 4 threads` | `proving: 4 threads` |
| MOCK badge | absent | absent |

Screenshot of the done screen: [m3-sent.png](m3-sent.png). Video of the whole run:
`/root/Projects/web3-sweep/zenvelope-video/m3-broadcast.webm` (and `.mp4`), 1280×720.

The run also asserted what every dry run asserts: no page error, the link secret in **no**
request URL, and `localStorage` and `sessionStorage` both `{}` at the end.

### Stage timings

Painted in the page, recorded by a `MutationObserver` on the stage rows' `data-state`:

| Stage | Wall time |
| --- | --- |
| `witness` | **26.6 s** |
| `keys` | 0.1 s |
| `proving` | **13.1 s** |
| `broadcast` | **0.4 s** — the real `SendTransaction`, where every dry run skipped it |
| **tap → Done** | **40.3 s** |

`proving` at 13.1 s and the warm key at 14.9 s match M4's four-thread table (14.7 s and
16.1 s). `witness` is 26.6 s against M4's 8.1 s: it is network round trips and a block
range that has grown by ~470 blocks since M4 measured it, which is the caveat
[M4-VERIFICATION.md](M4-VERIFICATION.md) §3 already puts under its own table. A dry
rehearsal on this same build, minutes earlier, gave the same shape — witness 25.6 s,
keys 0.1 s, proving 13.5 s, 39.2 s tap to done — so the only difference the real run made
was the 0.4 s of `broadcast`.

### The oracle: three independent wallets

`zcash-devtool` (`/root/Projects/web3-sweep/tools/zcash-devtool`), view-only wallets, the
`zecrocks` servers — none of Zenvelope's own code. The two new wallets were created with
`wallet init-fvk` from the UFVKs in the gitignored `M3-DEST.md`, birthday 3,490,472.

| Wallet | Command | Result |
| --- | --- | --- |
| **(a) the M1 envelope** `tools/wallets/m1-fund-watch` | `sync` + `balance --json` | `{"total": 0, …}` — **the note is spent**. `list-tx` now lists two transactions: the funding `281e9f7b…341d43` at 3,490,472 and `ba0f91cf…fa2aad` at **3,491,056**, the latter with **0 notes received** |
| **(b) the destination wallet** `tools/wallets/m3-dest-watch` | `init-fvk` + `sync` + `balance --json` | `{"total": 90000, …}` — **90,000 zat received**, `list-tx`: output 0 of `ba0f91cf…fa2aad`, **Ironwood**, 0.00090000 ZEC, mined 3,491,056 |
| **(c) the fee envelope** `tools/wallets/m3-fee-watch` | `init-fvk` + `sync` + `balance --json` | `{"total": 30000, …}` — **30,000 zat received**, `list-tx`: output 1 of the same transaction, **Ironwood**, 0.00030000 ZEC, mined 3,491,056 |

130,000 in, 90,000 + 30,000 out, 10,000 to the miners. The arithmetic on the review screen
is the arithmetic on the chain.

Confirmations were polled until the chain had moved past the block. At 11:19 UTC the tip
was **3,491,060** — four blocks above the one that carries the transaction — with all
three balances unchanged, and the two receiving wallets still reported their notes as
`total` but not yet `ironwood_spendable`, which is the wallet's confirmation rule, not a
doubt about the transaction. At 11:30 UTC, tip **3,491,068** (twelve confirmations), both
had crossed it:

```
m1-fund-watch  {"chain_tip_height":3491068,"ironwood_spendable":0,    "total":0}
m3-dest-watch  {"chain_tip_height":3491068,"ironwood_spendable":90000,"total":90000}
m3-fee-watch   {"chain_tip_height":3491068,"ironwood_spendable":30000,"total":30000}
```

The recipient's 90,000 zatoshi are spendable, from a link that was opened in a browser.

### The product's own view of the fee envelope

The fee output is an ordinary Zenvelope envelope, so the product can open it. Loading
`/e?dry=1#<fee secret>` in the same browser and tapping "Open envelope":

```
fee envelope in the app: 0.0003 ZEC (13.2 s)
```

The app scans, decrypts and reveals the fee it was paid, by the same path a recipient
uses. The fee envelope's secret is the money and stays in the gitignored `M3-DEST.md`.

### What this build was

Rebuilt from this tree for the broadcast, so the numbers above belong to the code that is
committed here and not to M3's or M4's snapshot:

```
wasm (1 thread): 2,249,295 bytes raw, 1,062,892 gzip
wasm (threads):  2,302,997 bytes raw, 1,087,121 gzip
npm run build:   tsc -b && vite build, clean, 134 modules
```

Both are larger than M4's table (2,231,700 and 2,285,245) by the M5 Solana exit and the
group-envelope code that landed after it; the circuit is unchanged.

### Exact commands

```sh
./scripts/build-core.sh                    # both wasm packages
cd web && npm ci
VITE_FEE_ADDRESS="$ZENV_M3_FEE_ADDRESS" npm run build
npm run preview -- --host 127.0.0.1 --port 4207 --strictPort

# the broadcast: Playwright's own chromium, 1280x720, recordVideo on,
# /e#<fragment> with NO ?dry=1
node <driver>.mjs                          # the driver is not in the repo: it is a
                                           # one-shot that spends a real envelope

# the oracle
B=/root/Projects/web3-sweep/tools/zcash-devtool/target/release/zcash-devtool
W=/root/Projects/web3-sweep/tools/wallets
"$B" wallet -w "$W/m1-fund-watch" sync -s zecrocks && "$B" wallet -w "$W/m1-fund-watch" balance --json
"$B" wallet -w "$W/m3-dest-watch" init-fvk --name m3-dest --fvk "$DEST_UFVK" --birthday 3490472 -s zecrocks
"$B" wallet -w "$W/m3-dest-watch" sync -s zecrocks && "$B" wallet -w "$W/m3-dest-watch" balance --json
"$B" wallet -w "$W/m3-fee-watch"  init-fvk --name m3-fee  --fvk "$FEE_UFVK"  --birthday 3490472 -s zecrocks
"$B" wallet -w "$W/m3-fee-watch"  sync -s zecrocks && "$B" wallet -w "$W/m3-fee-watch"  balance --json
```

The driver that broadcasts is deliberately **not** committed: `e2e/m3-real.spec.ts` stays
dry-run-only, so nothing in this repository can spend an envelope by being run.

**M3 is done.** A link, on mainnet, opened in a browser and swept to its recipient with
the proof built in that browser. Nothing in the path held the money.
