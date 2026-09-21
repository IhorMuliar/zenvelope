# M4 verification (part A)

Evidence that the **core is off the page's main thread** and that it can prove with
**four threads**, measured on the same real, funded mainnet envelope M3 used, through the
product's own screens.

M3's finding was that a recipient watching a sweep saw nothing: the prover held the main
thread for 42 seconds with no `await` in it, so the four-stage checklist froze on its
first row and the elapsed clock stopped ([M3-VERIFICATION.md](M3-VERIFICATION.md) §4).
Both halves of the fix are here — the core in a Web Worker, and a threaded wasm package —
and the table below is what they bought.

**Nothing was broadcast.** Every run on this page took the dry-run path: the page was
loaded with `?dry=1`, `SendOn` passed `broadcast: false` to `sweep_envelope`, and the
dry-run done screen (with its own `raw_tx_hex` and "not sent" copy) is asserted on the way
out of every one. The money is still in the M1 envelope and the link still works.

Run on 2026-09-21, branch `worktree-agent-ae72df878a852d942`.

- Host: 8-core x86_64 Linux, no CPU throttling
- Browser: Playwright's own chromium, against the production build served by
  `vite preview` with the production COOP/COEP headers
- Network: **mainnet** throughout
- Envelope under test: the M1 one (tx `281e9f7b…341d43`, block 3,490,472, 130,000
  zatoshi = 0.0013 ZEC, one Ironwood note at action index 1). Its link fragment, the
  destination and the fee address are the money, so they live in the gitignored
  `M1-FUND.md` and `M3-DEST.md`, are read from the environment at run time, and are
  never printed or committed.

## 1. The worker

`web/src/core/worker.ts` is now the only thread that ever holds a wasm module.
`web/src/core/index.ts` spawns it and hands the pages an RPC client
(`web/src/core/client.ts`) whose every method is a promise.

- **What crosses:** only structured-cloneable values. The wasm-bindgen structs are copied
  into plain objects and `free()`d inside the worker.
- **The two callbacks** (`on_progress`, `on_stage`) never cross: the client keeps them,
  posts `null` in their slot, and calls them from the worker's `progress` and `stage`
  messages, tagged with the call's id.
- **The secret** is posted as an ordinary argument and kept by neither side: no storage,
  no log, no module-level variable.

`web/src/core/client.test.ts` drives the whole protocol against a fake worker in Node —
the handshake, argument marshalling, both callbacks, out-of-order answers, a late report
for a finished call, and a worker that dies.

## 2. Two wasm packages, and which one loads

`scripts/build-core.sh` builds `crates/core` twice.

| | `web/src/wasm/core` | `web/src/wasm/core-mt` |
| --- | --- | --- |
| features | default | `multicore` (`orchard/multicore` + `wasm-bindgen-rayon`) |
| toolchain | stable | nightly, `-Z build-std=std,panic_abort` |
| memory | its own | **imported, shared**, max 2 GB |
| wasm, raw | **2,231,700 bytes** (2,179 KB) | **2,285,245 bytes** (2,231 KB) |
| wasm, gzip | 1,055,426 bytes (1,030 KB) | 1,079,393 bytes (1,054 KB) |

The threaded package costs **+53,545 bytes raw (+2.4%)**, +23,967 gzipped. Both are built
with the same `wasm-opt -Oz` list, so the difference is rayon, `crossbeam-channel`, the
thread-local setup and the atomics-built `std` — not a different optimisation level.

The single-threaded package is 43 bytes larger than M3's 2,231,657, which is the two new
exports (`is_threaded`, `thread_count`).

The worker takes the threaded package only when all three hold — `self.crossOriginIsolated`,
a hand-rolled wasm-threads probe (the canonical `i32.atomic.load` module, plus a
`SharedArrayBuffer` `postMessage`), and more than one reported core — and **any** failure
after that falls back to the single-threaded package rather than leaving a recipient
unable to open an envelope. Which one won is on screen as a footer note.

```
✓ 4 e2e/m4-worker.spec.ts (4 tests)
M4 footer: proving: 4 threads
```

`e2e/m4-worker.spec.ts` also asserts that the page is cross-origin isolated and that the
page's own `window` holds no core: `sweep_envelope`, `warm_proving_key`, `wasm` and
`__wbindgen_start` are all absent from it.

## 3. The numbers

The same envelope, the same destination, the same build, through the same screens. The
only variable is the pool: `?threads=1` caps it at one, which sends the worker down the
single-threaded package. M3's column is the run recorded in
[M3-VERIFICATION.md](M3-VERIFICATION.md) §4, on this same host.

| | M3 (main thread, 1 thread) | M4, 1 thread | M4, 4 threads | 4 threads vs 1 |
| --- | --- | --- | --- | --- |
| proving key, in the background (`warm_proving_key`) | 29.0 s | **28.8 s** | **16.1 s** | **1.79x** |
| "Send it on" tapped → Done | 48.9 s | **47.4 s** | **22.9 s** | **2.07x** |
| ├ `witness` (network: tree state, the note's block, the walk to the anchor) | 6.9 s | 7.5 s | 8.1 s | — |
| ├ `keys` (ZIP-32 from the link secret) | 0.1 s | 0.1 s | 0.1 s | — |
| ├ `proving` (one Ironwood spend proof) | 42.0 s | **39.8 s** | **14.7 s** | **2.71x** |
| └ `broadcast` | skipped | skipped | skipped | — |
| raw transaction | 9,166 bytes | 9,166 bytes | 9,166 bytes | identical |

The new-wallet path, which generates 24 words in the worker and sweeps to the address they
produce, runs the same: **22.2 s** tap to done at four threads against **50.9 s** at one,
`proving` 14.4 s against 42.9 s, warm 16.6 s against 27.7 s. Two destinations, two
independent runs of each configuration, the same ratio.

Two things worth saying plainly:

- **`witness` did not get faster, and should not have.** It is network round trips plus a
  block-range stream, and it gets slightly *longer* as the envelope ages and the anchor
  walk lengthens. Threads do nothing for it.
- **Nearly all of the win is in `proving`, and it stops at four threads.** 2.71x here
  matches the M4 spike's 2.6x at four and 2.8x at eight
  ([spike/README.md](../../spike/README.md)): only halo2's MSM and FFT are parallel, so
  the curve flattens almost immediately. `MAX_PROVING_THREADS = 4` is that measurement,
  not a guess, and it leaves half an 8-core machine to the rest of the browser.

Together, **a recipient who taps "Send it on" with a warm key waits 22.9 s where M3 made
them wait 48.9 s**, and the wait before that — the key building while they choose a
destination — halved too.

### Re-measured after the M4 part B merge

Part A (this worker and the two packages) and part B (the copy, the trust boundary and
the group preview) were merged on 2026-09-21, and `Create.tsx` moved onto the async core
in that merge. Both wasm packages were rebuilt from the merged tree — byte for byte the
same sizes as the table in §2 — and the four-thread dry sweep re-run through the same
screens on the same host:

```
M4 proving: 4 threads
M4 proving key warm: 15.0 s
M3 real dry run (pasted address): elapsed 0:10 -> 0:13 while proving
M3 real dry run (pasted address): tap to Done 24.4 s — painted witness 9.6 s, keys 0.1 s, proving 14.6 s
M3 real dry run (pasted address): raw transaction 9166 bytes
M3 real dry run (new wallet):     tap to Done 23.9 s — painted witness 8.5 s, keys 0.1 s, proving 15.3 s
M4 footer: proving: 4 threads
```

**The table holds.** `proving` is 14.6 s against the table's 14.7 s and the warm key 15.0 s
against 16.1 s — the part threads actually own is unchanged. Tap to done is 24.4 s against
22.9 s, and the whole 1.5 s of that is `witness`, which is network round trips and got
slower as the envelope aged and the anchor walk lengthened: exactly the caveat §3 already
puts under the table. Same 9,166-byte transaction, and the footer still reads
**`proving: 4 threads`**.

Both runs were dry runs. Nothing was broadcast.

### Phone measurement

Measured 2026-09-21 on the owner's own device, against the deployed site rather than a
preview server, on a real mainnet envelope. The sweep took the dry-run path: **nothing
was broadcast**, and the envelope still holds its money.

- **Device:** iPhone 16e, Brave on iOS (WebKit), `navigator.hardwareConcurrency` **2**
- **Site:** <https://zenvelope.netlify.app> (Netlify). The COOP/COEP headers were
  verified on the live responses, the page was **cross-origin isolated**, and the worker
  took the threaded package: proving on **2 threads**, as the footer reported.
- **Transaction:** the same **9,166-byte** transaction the desktop rows above produce.

| | iPhone 16e, Brave, 2 threads | desktop, same hour, 4 threads |
| --- | --- | --- |
| open / scan | **7.6 s** | 25.8 s |
| keys (warm) | **4.9 s** | 15.8 s |
| `witness` | **8.4 s** | 28.4 s |
| `proving` | **5.1 s** | 13.8 s |
| "Send it on" tapped → Done | **13.5 s** | 42.3 s |
| raw transaction | 9,166 bytes | 9,166 bytes |

The desktop column is the reference run taken the same hour on the 8-vCPU DigitalOcean
droplet in Chrome at four threads, through the same live site.

**Read the desktop column as network, not as compute.** Its rows are much larger than
the same machine's rows in the table above (22.9 s tap to done, `proving` 14.7 s), and
the difference is mostly latency to the public gateway at that time: `open / scan` and
`witness` are round trips and a block-range stream, and they are where the gap sits.
Neither column is a benchmark — one run each, an hour apart, on different networks — so
what is worth taking from them is the phone's own figures: a recipient on an iPhone 16e
waited **13.5 s** from "Send it on" to done, **5.1 s** of it proving.

### Peak memory

Not instrumented here: `crates/core` exports no memory probe, and adding one is a rebuild
of both packages for a number the M4 spike already took on this host with the same circuit
— **100.8 MB at 1 thread, 108.8 MB at 4** ([spike/README.md](../../spike/README.md)). The
threaded run adds roughly 2 MB per worker thread of stack and thread-local space, and the
proving key dominates either way. Nothing came close to the wasm32 ceiling in any run, and
no run was killed.

## 4. The freeze is gone

`e2e/m3-real.spec.ts` now refuses to pass unless the recipient can actually see the proof
happening. Mid-proof it asserts that:

- the `proving` row is **visible** and `data-state="active"`
- `witness` and `keys` are already painted `done` — reported *and* rendered
- the elapsed clock, read twice across a real 3-second gap, has advanced, with `proving`
  still active at the second reading

```
M3 real dry run (pasted address): elapsed 0:08 -> 0:11 while proving
M3 real dry run (new wallet):     elapsed 0:07 -> 0:10 while proving
```

**This is the worker's doing, not the threads'.** The single-threaded run has the same
assertions and passes them:

```
M4 proving: 1 thread
M3 real dry run (pasted address): elapsed 0:07 -> 0:10 while proving
```

so a browser that falls back to the single-threaded package gets a slower sweep and a
progress screen that still works. That is exactly the split M3's finding predicted: the
freeze was about *where* the proof ran, and the threads are about *how long* it takes.

The `broadcast` row is the one stage that may not be painted. On a dry run the core
reports it and `done` back to back, and React coalesces both into the render that shows
the done screen; the spec allows its absence and requires the other three, in order.
Which is the stage being instant, not the page being blind — the ticking clock rules that
out.

## 5. Trimming the wasm: not possible without a fork

The task was to drop `zcash_primitives`' `circuits` feature, which also enables
`sapling/circuit` and with it bellman and groth16 — a Sapling prover this product never
calls, because [`NoSaplingProver`](../../crates/core/src/spend.rs) stands in for it.

**It cannot be done, and it would buy almost nothing.** In `zcash_primitives` 0.30.1:

```toml
circuits = ["orchard/circuit", "sapling/circuit"]
```

and `Builder::build` — the only entry point that produces a transaction — is
`#[cfg(feature = "circuits")]` (`src/transaction/builder.rs:1386`), as is
`cached_orchard_proving_key`, which `warm_proving_key` primes. Cargo features are
additive, so there is no way to take the Orchard half without the Sapling half: dropping
`circuits` drops `build`. Splitting the feature upstream needs a `[patch.crates-io]` fork
of a consensus-critical crate, which this repo does not do (the same reasoning already
rejected a fork in `crates/core/README.md`, "Warming the proving key").

What it would have been worth, measured rather than guessed:

| | |
| --- | --- |
| `bellman` strings in the shipped wasm | **0** |
| `groth16` strings in the shipped wasm | **0** |
| `crates/spike-prove` (orchard circuit only, no `zcash_primitives`, no Sapling), `opt-level = "z"` | 1.50 MB raw |
| `crates/core` today | 2.18 MB raw |

The whole 680 KB difference has to cover `zcash_primitives`, `zcash_keys`,
`zcash_client_backend`, `tonic`, `tonic-web-wasm-client`, `zcash_transparent` and
`bip0039` as well, and the Groth16 prover leaves no trace in the binary at all: nothing
reachable from `build::<_, NoSaplingProver, NoSaplingProver, _>` calls it, so LTO and
`wasm-ld` drop it. **Before and after are the same bytes**, and the fork is not worth it.

Reported, not done, as instructed.

## 6. Several notes in one envelope: deferred

`sweep_envelope` still spends **one** note, and the open screen still says so ("This
sends on the payment shown above. Any others stay in the envelope."). Making it spend all
of them in one transaction is more than the hour the task allowed, and the reason is
`WitnessScan` in `crates/core/src/spend.rs`:

- it holds a single `Option<IronwoodWitness>` and `append_block` takes one target; N notes
  need N witnesses advanced in lockstep, and a replay that starts at the **earliest**
  note's block rather than the one note's block
- `SweepPlan` carries one `note` and one `merkle_path`; `build_and_prove` adds one spend
- `plan_amounts` sums one note value, and `network_fee_zat` would have to count actions as
  `max(spends, outputs)` rather than assuming two
- the JS boundary, `SweepRequest`, the TypeScript contract and `SendOn`'s "largest note
  first" shortcut all follow
- and the native integration test (`crates/core/tests/m3_sweep.rs`) would need a
  multi-note envelope to be funded before any of it could be trusted

None of it is hard; all of it is load-bearing for real money, and it is a milestone of its
own rather than a tail-end change to this one.

**Since done.** `sweep_envelope` now takes an array of notes and spends all of them in one
transaction: `WitnessScan` carries one witness per note and advances them to a shared
anchor, `network_fee_zat` counts `max(spends, outputs)` actions, and the open screen's
"Any others stay in the envelope" is gone — the review screen shows the sum. The finding
above stands as the reason it was a milestone of its own. See
[crates/core/README.md](../../crates/core/README.md#several-notes-one-anchor); the one-note
M1 sweep is unchanged at 9,166 bytes, asserted natively and in the browser.

## 7. Nothing regressed

| | |
| --- | --- |
| `cargo test` | **72 passed**, 0 failed, 2 ignored in `zenvelope-core` (+ 1 passed, 3 ignored in `tests/m3_sweep.rs`) |
| `node scripts/smoke-core.mjs` | **17 checks passed** against the freshly built single-threaded package |
| `npm test` (vitest) | **230 passed** in 14 files, including the 13 RPC tests in `src/core/client.test.ts`, 4 async-destination tests, and the 31 group tests now driven through the RPC client |
| `npm run build` | clean, `tsc -b` included |
| e2e, real core (27 specs) | **15 passed, 12 skipped**, 0 failed — the 12 are the MOCK-only groups, which skip when a wasm build is present |
| e2e, MOCK core (wasm moved aside) | **12 passed, 15 skipped**, 0 failed |

The counts above are the merged tree — part A plus part B. Part A alone reported 168
vitest tests over 21 e2e specs; part B brought the copy audit, the trust boundary, the
group builder and `e2e/m4-group.spec.ts`.

The M3 evidence still holds on the new path: `e2e/m3-core.spec.ts`, which drives the wasm
exports directly on a bare page rather than through the app, reports the same shape it did
in M3 — proving key 29.2 s (second call 0 ms), sweep 47.5 s, `proving` 39.6 s, raw tx 9,166
bytes, stages `witness → witness → witness → keys → proving → broadcast → done`.

The word "claim" appears nowhere in the body of any screen; every real run asserts it.

## 8. Nothing was broadcast

Every sweep on this page ran with `broadcast: false`:

- the page was loaded at `/e?dry=1#…`, and `SendOn` reads `?dry=1` once at mount
- the core's own verdict, `SweepResult.broadcast === false`, is what puts the done screen
  into its dry-run form; the flag that asked for it is not trusted
- each run asserts the heading `Dry run complete.`, the line "Dry run: transaction built
  and proved, not sent", a 9,166-byte raw transaction, **no** explorer link, and the copy
  "Nothing was sent. The money is still in the envelope, and this link still works."
- `localStorage` and `sessionStorage` are both `{}` at the end of every run, and the link
  secret appears in no request URL

The M1 envelope still holds its 0.0013 ZEC.

## 9. Exact commands

```sh
# from the repo root
./scripts/build-core.sh          # both packages; ZENVELOPE_SKIP_MT=1 for just the first
cargo test -p zenvelope-core
cd web && npm ci && npm test && npm run build

# The fragment, the destination and the fee address are the money, so they are read from
# the private, gitignored M1-FUND.md and M3-DEST.md at run time, never echoed and never
# committed. VITE_FEE_ADDRESS has to be set for the BUILD as well as for the run.
export ZENV_M1_FRAGMENT='<secret>.<birthday>'
export ZENV_M3_DEST_ADDRESS='u1…'
export ZENV_M3_FEE_ADDRESS='u1…'
export VITE_FEE_ADDRESS="$ZENV_M3_FEE_ADDRESS"

npm run build
npx playwright test                                  # everything, threaded
ZENV_M4_THREADS=1 npx playwright test e2e/m3-real.spec.ts   # the 1-thread row
```

`ZENVELOPE_E2E_PORT=4193` (or any free port) moves the preview server off the default
4173, which is what to do when another checkout of this repo is already serving there.


`ZENV_M4_THREADS=1` puts `?threads=1` on the page, which caps the pool at one and so
sends the core worker down the single-threaded package — both rows of the table above
come off one build.

---

## Security fixes 2026-09-21

A read-only security review of the tree at `20ff781` produced eleven findings and one
observation. Every one of them is answered below: what it was, what changed, and the
test that would catch it coming back. Nothing in this section was broadcast — the real
runs took the `?dry=1` path exactly as the rest of this document did, and the envelope
under test is now the **fee envelope** (0.0003 ZEC, unspent) rather than the M1 one,
which the M3 sweep emptied.

| Finding | What it was | Fix | Test |
| --- | --- | --- | --- |
| **H1** | The link secret stayed in `location.hash` for the whole open → scan → prove flow, and so in the history entry, in browser sync and in "share this page" — while the screen said the secret had stayed in the browser | `/e` reads the fragment once and then `history.replaceState(null, "", location.pathname + location.search)`; every retry re-scans from the in-memory ref. A reload loses it, by design, and every screen says so (DECISIONS **D15**) | `src/lib/fragmentStrip.test.ts`; `e2e/m2-open.spec.ts` — hash empty after the open, the reload screen, Back and Forward both clean; the same assertion on the real core in `m3-real` and `m5-real` |
| **H2** | The CSP lived only in a Netlify/Cloudflare `_headers` file with no host configuration committed and no `<meta>` fallback: on any other host the app shipped with no CSP, no COOP/COEP and no `frame-ancestors`, silently | `index.html` carries the same policy as `<meta http-equiv="Content-Security-Policy">` (minus `frame-ancestors`, which a meta cannot express and `X-Frame-Options: DENY` backs up); `netlify.toml` is committed with the headers, the build and the SPA redirect; `web/README.md` documents the Cloudflare Pages setup | `src/lib/headers.test.ts` parses all three files and fails on any drift between them |
| **M3** | A swap plan survived backing out of the Solana exit: the review screen went on promising USDC on Solana above a button that paid a unified Zcash address, and the Sent screen mounted a tracker polling an address nobody had paid | `setSwap(null)` on every pick handler, on backing out of the exit, and in "Choose somewhere else" (which now resets the destination too); the review, Sent and dry-run screens render swap UI only through `showSwapUi(choice, swap)` | `src/lib/swapSafety.test.ts` (the predicate); `e2e/m5-solana.spec.ts` — "takes the swap screens away when the destination changes", asserting no tracker and **no further status poll** |
| **M4** | The 1Click refund override was free text that went straight into `refundTo`. A typo or a testnet address makes a `REFUNDED` swap unrecoverable | The override goes through `classify_address` like every other Zcash address — unified with an Orchard receiver, or transparent, on this network — and `canQuote` is false until it passes, with the core's reason on screen | `src/lib/swapSafety.test.ts` (the gate, including a late verdict about text already typed past); `e2e/m5-solana.spec.ts` — "classifies the refund address before it will quote anything", asserting the rail was asked nothing meanwhile |
| **M5** | `spreadBps` was computed and displayed but never enforced, and `minAmountOut` was never read: a response with `amountOut ≈ 0` was accepted with nothing but a percentage on screen | `MAX_SPREAD_BPS` (config, **1500**) caps the cost of leaving, `effectiveCost().ok` must be true, and `amountOut >= minAmountOut` is required. `canGetDeposit` is false otherwise and the screen says which rule failed, with the numbers | `src/lib/swapSafety.test.ts` (cap boundary, unreadable figures, shortfall); `e2e/m5-solana.spec.ts` — "refuses a quote whose spread is over the cap", including deleting the `disabled` attribute and asserting **no real quote was ever asked for** |
| **M6** | The rail's deposit address was classified but any payable kind was accepted, and `quoteRequest` was never compared with what we asked for | `checkSwapPlan` requires `kind === "transparent"` and compares the echoed `recipient`, `refundTo` and `destinationAsset` with the request. A failure throws the reservation away and never reaches the sweep | `src/lib/swapSafety.test.ts` (every field, both directions); `e2e/m5-solana.spec.ts` — a `u1…` deposit address and two tampered echoes, each ending on the error screen with no "Send it on" anywhere |
| **M7** | Pasting a `t1` left the shielded pool behind one warning line, while the same privacy loss through the Solana card needed a full `TrustBoundary` tick | A pasted transparent address goes through the same component, with transparent-specific copy (`transparentBoundary` in `src/copy/en.ts`): four things you give up, and a tick that is the only way to the review screen | `src/components/TrustBoundary.test.ts` (the variant, same gate); `e2e/m3-open.spec.ts` — the gate, the attribute-deletion attempt, the way back, and a unified address **not** being gated; `e2e/m5-real.spec.ts` walks it on the real core |
| **L8** | No `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` in `public/_headers` and `netlify.toml`. `preload` is deliberately left off until there is a domain of our own to submit (D9) | `src/lib/headers.test.ts` |
| **L9** | If the core rejected the rail's address, the review dispatch was skipped, `SolanaExit` unmounted and its reservation was lost with no message at all | The reason is shown on the choose screen with a "Start the swap again" button | `e2e/m5-solana.spec.ts` — the retry lands back on the trust boundary |
| **L10** | `describeDestination` discarded the core's `reason` and guessed the wrong-network case from a prefix regex, so most wrong-network pastes read as "that does not look like a Zcash address" | The regex is gone; `DestinationState.reason` carries the core's own words and the field renders them under the product's line | `src/lib/destination.test.ts`; `e2e/m3-open.spec.ts` — "shows the core's reason under a refused address" |
| **L11** | `README.md` stated that subresource integrity and reproducible builds mitigate the served-JS risk. Neither exists | The paragraph now states what is true — static hosting, a strict CSP delivered three ways, same-origin wasm in a worker, committed lockfiles, the stripped fragment — and lists SRI and reproducible builds as **planned**, with the reason each is not yet possible | Prose; `src/lib/headers.test.ts` keeps the CSP half of the claim honest |
| **I12** | The secret was a React prop (`Open.tsx`, `SendOn.tsx`), so DevTools printed it in full, unlike the ref it came from | `Open` passes a getter; `SendOn` calls it in one place, inside the sweep. No component takes the string | `src/components/SendOn.test.ts` — the getter is not called during a render, the secret is in no markup, and the props object serialises without it |

### The residual on I12

A getter is not a vault: anything executing in the page can call it, exactly as it could
read the ref, and the secret is in the core worker's memory while a sweep runs. What it
buys is that the bearer capability is no longer sitting in the React element tree where a
casual DevTools inspection, a screen share or an error overlay would print it. The CSP is
what is supposed to stop hostile script; this is what is left if something gets past it.
It is documented in the same terms in `web/README.md` and at the top of
`src/components/SendOn.test.ts`.

### A deliberate consequence: small swaps are refused

`MAX_SPREAD_BPS = 1500` is a product decision with teeth. A swap at the rail's floor
really does cost 16-18% to leave, because a flat Solana withdrawal fee spread over about
$2 is enormous — the recorded quote in `e2e/m5-solana.spec.ts` is 18.03%. Those swaps are
now refused rather than offered with a percentage next to a live button, and the screen
says the number and the cap. The mocked flow tests therefore use the same recorded body
with a healthier `amountOutUsd`, and the recorded figures are kept as the test of the cap
itself.

### The runs behind this section

Everything was re-run on 2026-09-21 after the fixes, on the branch
`worktree-agent-a41aa356d6cc58f70`.

| Run | Result |
| --- | --- |
| `npm test` | **377 passed**, 21 files (322 before: +55 for these fixes) |
| `npm run build` | clean, `tsc -b` included |
| MOCK e2e, wasm moved aside, port 4212 | **28 passed**, 17 skipped (the real groups) |
| `e2e/m2-open.spec.ts`, real core, port 4211 | **1 passed** — the fee envelope opened on mainnet, 639 blocks (3,490,472..3,491,110) in 20.1 s, `location.hash` empty |
| `e2e/m3-real.spec.ts`, real core, port 4211 | **2 passed** — proving key warm 17.6 s and 17.0 s at 4 threads, tap to Done 23.6 s and 23.8 s, 9,166-byte proved transaction each, both **dry** |
| `e2e/m5-real.spec.ts`, live 1Click, port 4211 | **1 passed** — the rail's floor read live (132,000 zatoshi), a real deposit address reserved (`t1XQhP…NhTf`, `PENDING_DEPOSIT`, deadline 2026-09-24), the transparent trust boundary ticked, and a 9,200-byte proved transaction to it, **dry** |

The envelope under test is the fee envelope: **0.0003 ZEC**, which is why
`ZENV_EXPECT_ZEC` exists and why `VITE_FEE_ADDRESS` is unset for these runs —
30,000 zatoshi cannot pay a 30,000 zatoshi flat fee and a miner fee on top.

**Nothing was broadcast.** Every page load was `?dry=1`, every done screen was
asserted to be the dry-run one ("Nothing was sent. The money is still in the
envelope, and this link still works."), no explorer link was rendered on any of
them, and `localStorage` and `sessionStorage` were `{}` at the end of every run.
The one live side effect is the deposit address the M5 run reserved from the
rail, which nobody paid and which expires in three days. The fee envelope still
holds its 0.0003 ZEC.

### What was already right

The review found no `dangerouslySetInnerHTML`, no `innerHTML`, no `eval`, no storage API
and no beacon anywhere in `web/src`; the memo renders as a plain text child; the CSV
export neutralises formula injection; the worker boundary strips callbacks and pins the
wasm URL to `self.location.origin`; the Rust destination rules enforce the network and
refuse Sapling, TEX and Orchard-less unified addresses with reasons; and `?dry`, `?net`,
`?poll` and `?threads` are read from `location.search` and never from the fragment. None
of that changed.
