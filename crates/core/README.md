# zenvelope-core

The envelope core. A link secret in, a shielded Zcash address and a ZIP-321 payment URI
out (M1), the notes that address received (M2), and the proved Ironwood transaction that
spends them (M3). Compiled to WASM for the browser; usable as a plain Rust crate for tests
and tooling.

Nothing here writes to disk, and no key is ever state: the secret is an argument and a
return value. Key derivation, address classification, ZIP-321 and wallet generation stay
offline. The two exports that reach the network are `open_envelope` and `sweep_envelope`,
and they talk only to the lightwalletd gateway the caller names.

**This file is the contract the web app builds on.** If an implementation and this
document disagree, the disagreement is a bug in one of them, and the fix goes in both.

## The secret

32 bytes from the browser CSPRNG (`crypto.getRandomValues`), encoded **base64url
without padding**: exactly 43 characters from `[A-Za-z0-9_-]`.

The secret is not derived from anything. There is no parent seed, no mnemonic, no
recovery path. A lost link is lost money, and that is the design: the sender cannot
recover it, so neither can anyone else.

## Derivation

The 32-byte secret is used directly as the **ZIP-32 seed**. The account is always
account 0.

```
secret (32 bytes)
  -> UnifiedSpendingKey::from_seed(network, &secret, AccountId::ZERO)
  -> usk.to_unified_full_viewing_key()
  -> ufvk.default_address(UnifiedAddressRequest::ORCHARD)
  -> (UnifiedAddress, DiversifierIndex)
```

`UnifiedAddressRequest::ORCHARD` **requires** an Orchard receiver and **omits** Sapling
and transparent. The resulting unified address therefore carries exactly one receiver,
the Orchard receiver, unified typecode `0x03`. Post-NU6.3 ("Ironwood") that receiver
takes Ironwood notes; ZIP 258 forbids new value entering the Orchard pool itself.

Why only one receiver: a Sapling or transparent receiver in the same address would let a
sender's wallet pay into a pool the open flow cannot spend from, and a transparent
receiver would put the payment on a public chain in the clear. One receiver, one pool,
no way to get it wrong.

M2 links in `zcash_client_backend`, which requires `zcash_keys`'s Sapling support, so
"Sapling is not compiled in" is no longer what keeps Sapling out. What keeps it out now
is explicit: `derive` reduces the ZIP-32 output to its Orchard component with
`UnifiedFullViewingKey::from_orchard_fvk`, so the exported `ufvk` carries exactly one
key, matching the address's one receiver. Without that reduction the UFVK would silently
grow a Sapling item and its `uview1…` encoding would change; the fixed vectors in
[TEST_VECTORS.md](TEST_VECTORS.md) are the regression test for it. `transparent-inputs`
remains off everywhere.

Derivation is deterministic: the same secret and the same network always give the same
address and viewing key, on any machine, in any build.

### What comes back

| Field | Meaning |
| --- | --- |
| `address` | The unified address the sender pays. `u1…` on mainnet, `utest1…` on testnet. |
| `ufvk` | The unified full viewing key. `uview1…` / `uviewtest1…`. Finds the note when the link is opened. |
| `diversifier_index` | The index the address was found at. Always `0` in practice: Orchard has no invalid diversifiers, so the default address is the one at index 0. |

Mainnet is the default target; testnet is selectable and exists for development only.
Per [D4](../../docs/DECISIONS.md), there is no testnet milestone.

## Link fragment

```
<secret>
<secret>.<birthday>
```

`birthday` is the decimal block height at the moment the link was created, as a `u32`.
It is optional, and it is only a scan hint: it tells the recipient's light client where
to start, so opening a link does not mean scanning the whole chain. It is not a secret
and it is not part of the derivation. A birthday equal to the height the envelope was
funded at is the "final" form of the link: same format, but the scan starts at the
payment's own block instead of at the moment the link was made. The create page hands
one out when it sees the payment arrive while the tab is still open.

```
#AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA.3490400
 \_________________ secret, 43 chars _______/ \_ height _/
```

`parse_fragment` accepts a leading `#`, so `location.hash` can be passed through
unchanged. It validates the secret and rejects a non-decimal or out-of-range height
rather than handing back something that cannot derive. `build_fragment` returns the
fragment with no leading `#`; the caller decides where it goes.

## ZIP-321 payment URI

Exactly one output. Per [D5](../../docs/DECISIONS.md), multi-output ZIP-321 is not
portable across sender wallets, so the URI carries a single payment:

```
zcash:<address>?amount=<ZEC>[&memo=<base64url>]
```

`amount` is the **envelope amount plus the flat fee**, summed by the caller in zatoshi
as a `u64`. No float ever touches the money. It is rendered as decimal ZEC with at most
8 decimal places, no trailing zeros, and no trailing decimal point:

| zatoshi | `amount=` |
| --- | --- |
| `1` | `0.00000001` |
| `10000` | `0.0001` |
| `100000000` | `1` |
| `150000000` | `1.5` |
| `1234567891` | `12.34567891` |

Amounts of zero, and amounts above `MAX_MONEY` (2.1e15 zatoshi), are rejected.

### Why `memo=` and not `message=`

The sender's text rides in the ZIP-321 **`memo`** parameter: base64url of its UTF-8
bytes, no padding, at most 512 bytes (the size of the memo field). The sending wallet
puts those bytes in the note, where they are encrypted, and `open_envelope` decrypts them
and hands them back as `notes[].memo`. base64url is already URL-safe, so nothing in the
text can split the query into extra parameters.

`message=` was what M1 used and it is now gone. A ZIP-321 `message` is a human-readable
label *for the sending wallet's own history*: nothing in the spec puts it on the chain,
and nothing did. The funded M1 envelope was created with `message=Zenvelope%20M1` and the
zcash-devtool oracle reports `Memo: Memo::Empty` for the note it produced — the text
never left the sender's wallet. A message that the recipient can never see is a promise
the product cannot keep, so `payment_uri` does not offer one.

Text over 512 UTF-8 bytes is rejected rather than truncated, and the limit is counted in
bytes: one emoji is four of them.

Built with the [`zip321`](https://crates.io/crates/zip321) crate (0.9.0), which tracks
the same `zcash_address` 0.13 as the rest of the stack. Spec:
<https://zips.z.cash/zip-0321>.

## Opening an envelope (M2)

`open_envelope` is the whole recipient side of the read path: derive, sync, decrypt,
report. It returns a `Promise` so the page stays responsive while blocks stream in.

### Sync design

Two passes, and a deliberate refusal to keep a wallet database.

1. **Compact pass.** `GetLatestBlock` gives the chain tip. `GetBlockRange(birthday..tip)`
   then streams `CompactBlock`s, and every Orchard-family action in every transaction is
   trial-decrypted with the envelope's incoming viewing keys, batched per transaction
   through `zcash_note_encryption::batch`. The result of this pass is only a set of
   `(height, txid)`: a compact block carries the first 52 bytes of each note ciphertext,
   which is enough to recognise a note and not enough to read its memo.
2. **Full pass.** Each hit is fetched with `GetTransaction`, parsed with
   `Transaction::read` at the branch ID for its height, and decrypted with
   `zcash_client_backend::decrypt_transaction`, which yields value, memo, pool and
   transfer type. Typically this is one round trip, because an envelope has one note.

The transport is gRPC-web over `fetch` (`tonic-web-wasm-client`) driving the generated
`CompactTxStreamer` client from `zcash_client_backend`. A browser cannot speak gRPC, so
the endpoint must be a gRPC-web gateway: `https://zjs.zec.rocks/mainnet`, failing over to
`https://zcash-mainnet.chainsafe.dev` (D3). Progress is reported once per decrypted chunk
(`SCAN_CHUNK_BLOCKS`, 64 blocks) and once at each end of the range.

#### Two-phase open: reveal first, then verify

The walk's first block, the birthday, is scanned on its own. A final link
(`#<secret>.<H>`, H the block the payment was mined in) puts the note in exactly that
block, so it is found, fetched in full and handed to `on_progress` as an early
`{ kind: "note" }` event before the rest of the range has been read. The rest of the walk
then runs in `ScanMode::SpendsOnly`: no trial decryption, only a hash lookup of every
action's nullifier against the notes already found. That is download-bound rather than
CPU-bound (PERF §12: a 3,265-block check in under a second). When the first block holds
nothing, as with an original link whose birthday is the creation height, the walk stays
`ScanMode::Full` and is the scan described above. The trade: a `SpendsOnly` walk does not
look for a second payment in a later block; the original link's full walk still would.

#### What the compact pass does not do

Trial decryption is the whole cost of an open (about 96% of it; see
[web/docs/PERF-2026-09-21.md](../../web/docs/PERF-2026-09-21.md) §4), so the cheapest work
is the work skipped:

- **Sapling outputs are never trial-decrypted.** An envelope address carries one Orchard
  receiver, so no envelope can be paid in Sapling and there is no note there to find. Only
  `ironwood_actions` and `actions` are touched, with the account's Orchard IVKs.
- **A block with no Orchard-family action is skipped without allocating.** Two length
  checks per transaction answer it, against two vectors and two batch passes if it were
  not asked.
- **Each pool is skipped per transaction** when that transaction has no actions in it.

#### Threads

In the `multicore` package the compact pass is parallel. Blocks are buffered in chunks of
`SCAN_CHUNK_BLOCKS` (64) as they come off the single `GetBlockRange` stream, and each
chunk goes through rayon's `par_iter` — one block per unit of work, which is coarse enough
that scheduling is not the workload and fine enough to keep every thread busy. The
single-threaded package compiles the same loop with `iter()`; the parallel path is behind
`#[cfg(feature = "multicore")]` and the stable build is unchanged.

**The answers are identical either way.** Rayon's `collect` into a `Vec` preserves source
order however the work finished, and within a block the hits are pushed in `vtx` order, so
both builds produce the same `(height, txid)` list in the same order — and therefore the
same notes, with the same `action_index`, out of the full pass. That is not cosmetic:
everything downstream, the frontier replay above all, reads the chain in order.

The witness replay is **not** parallel and will not be: an Ironwood frontier is built by
appending commitments in chain order and every witness already taken absorbs each later
leaf, so there is no independent unit of work in it. What is bounded there instead is how
much of it runs, which is the anchor cap below.

Scanning starts at the birthday in the link fragment. Without one it starts at
`tip - 10000` (about eight days of mainnet) and says so in the result, via
`birthday_defaulted`. A birthday above the tip is clamped to the tip rather than
rejected: a link made seconds ago can legitimately name a height the server has not
served yet.

Measured on 2026-09-21 against `zjs.zec.rocks`, Playwright chromium, the funded M1
envelope: **63 blocks (3490437..3490499) in 1.9 s wall**, tip included, from a cold page;
2.7 s through the `/e` page, which also boots React and the app's own copy of the wasm.
See [web/docs/M2-VERIFICATION.md](../../web/docs/M2-VERIFICATION.md).

### How Ironwood notes are detected

NU6.3 added a second Orchard-shaped pool, and the difference is not in the wire format.

- In the protobuf, an Ironwood output arrives in `CompactTx.ironwood_actions`, a field
  separate from the Orchard `actions` field, carrying actions of the same shape. Same for
  the full transaction: `Transaction` has both an `orchard_bundle` and an
  `ironwood_bundle`.
- The pools are told apart by the note plaintext **version** inside the ciphertext:
  Orchard accepts version 2, Ironwood version 3. `orchard` expresses this as two note
  encryption domains over one key type, `OrchardDomain` and `IronwoodDomain`. Decrypting
  an Ironwood action with the Orchard domain fails silently, which is exactly the bug a
  scanner that only knows about `actions` would ship.
- Both pools are reached with the **same** Orchard incoming viewing key. That is why the
  Orchard receiver (typecode `0x03`) in the envelope's unified address receives Ironwood
  notes, and why no extra key material is derived for M2.
- The pool reported per note is read off the decrypted output's own `value_pool`, not
  inferred from which list it came out of.

`zcash_client_backend` 0.24 has all of this under its `orchard` feature; there is no
separate `ironwood` feature to switch on, which is why zcash-devtool detects Ironwood
with the same feature set.

### Spent detection

A note on chain is not money in the envelope: once someone sweeps it, the note is still
there and trial decryption still finds it. Before this, a swept envelope opened to its
old amount and the recipient only found out at broadcast, after half a minute of proving.
So the scan also checks whether each note it found has been spent, in the same walk.

- **The nullifier is derived the way the sweep derives it.** A compact action holds the
  first 52 bytes of the note plaintext, which is the whole note (version, diversifier,
  value, rseed), and the note's `rho` is that action's own nullifier field. So the compact
  pass rebuilds the full `orchard::Note` and calls `note.nullifier(&fvk)` with the link's
  Orchard full viewing key (`scan::note_nullifier`). That is the call orchard's builder
  makes inside `add_ironwood_spend(fvk, note, path)`, so the nullifier the scan watches is
  the one a sweep of that note reveals. The unit test
  `the_scan_derives_the_nullifier_the_sweep_reveals` checks exactly that: it funds a
  synthetic Ironwood note to the envelope, compact-decrypts it, spends it with orchard's
  builder and compares the builder's action nullifier with the scan's.
- **Every action is compared against that set.** `ironwood_actions[].nullifier` for an
  Ironwood note, `actions[].nullifier` for an Orchard note (`SpendWatch`, keyed by
  nullifier, one hash lookup per action). Nothing is looked at until the first note is
  found.
- **The parallel path stays correct.** Each chunk of `SCAN_CHUNK_BLOCKS` is decrypted in
  parallel first, its new nullifiers are added to the watch set on the driving thread,
  and then the same chunk is checked in parallel for spends. The matches are merged in
  chain order and the set carries over to later chunks, so a note funded and swept in the
  same chunk and a note swept thousands of blocks later are both caught. Workers only
  read the set, so no locks.
- **The full-transaction pass agrees or the open fails.** `notes_from_transaction`
  derives each note's nullifier again from the fully decrypted note; one that the compact
  pass never watched is an error, not a silent "unspent".

What comes back: each note carries `spent`, `spent_txid`, `spent_height` and
`spent_time` (that block's time from its compact header, unix seconds). `total_zat` now
counts **unspent notes only**, `spent_zat` counts the rest, `found` still means "ever
received anything", and `all_spent` means found and nothing left. The scan walks from the
birthday to the tip, so a spend is seen as long as it is at or below the tip the scan
reached. Cost: no extra round trip, since the blocks are already being streamed; see
[web/docs/M2-VERIFICATION.md](../../web/docs/M2-VERIFICATION.md), "Spent detection", for
the measurement.

### Memory footprint

The scan holds one compact block at a time plus a set of hits, and nothing else. There is
no block cache, no note commitment tree, no database: peak usage is the wasm linear
memory (a few MB, growing with the largest block seen) and is flat in the number of
blocks scanned. A 10,000-block default scan and a 57-block scan cost the same memory.
Nothing is persisted, so closing the tab leaves nothing behind — which is the privacy
property the product wants anyway.

### What M3 needed from M2, and what it reuses

M2 deliberately stopped at "what did this envelope receive". Spending needed a position
in the Ironwood commitment tree and a Merkle path to an anchor, which trial decryption
alone does not give. M3 gets both without a wallet database — see
[Sweeping an envelope](#sweeping-an-envelope-m3) below — and reuses the rest of M2
unchanged: the key derivation (`ufvk_from_secret` gives the Orchard-only UFVK, and the
spending key comes from the same seed), the gRPC-web transport and its generated client,
and the full-transaction Ironwood decryption that produces the note itself.

The one thing M2 now also reports is `notes[].action_index`: which Ironwood action in the
funding transaction is the envelope's. A sender's wallet takes its own change in the same
bundle, so a transaction usually has two Ironwood actions and only one is ours. `sweep`
needs to witness that exact commitment.

`zcash_client_memory` was evaluated as a note store and rejected: it was removed from the
librustzcash workspace on 2026-06-20, now lives at
<https://github.com/zcash/zcash_client_memory>, is pinned to `zcash_client_backend` 0.23
/ `orchard` 0.14 with zero Ironwood support, and is not on crates.io. M3 does not need it:
an envelope holds one note, so the "wallet state" is a single witness computed on demand
and thrown away.

## Sweeping an envelope (M3)

`sweep_envelope` spends **every** Ironwood note the envelope holds, in full, in **one**
transaction: one spend per note, one output to the destination the recipient chose, one
flat-fee output to Zenvelope (D5), no change.
`amount_to_destination = Σ notes − ZIP-317 network fee − flat fee`, and a sweep that would
leave nothing to send is refused rather than built.

An envelope usually holds one note, and then this is exactly what M3 did — the proved
transaction is the same 9,166 bytes it always was. An envelope holds more than one when
the sender pays it twice, or when a group of senders each pay the same link, and the
recipient should not have to open the link once per payment to collect them. Naming the
same note twice is refused before any network work: two spends of one note are two copies
of one nullifier, which no node accepts.

The whole sequence lives in `src/sweep.rs` and is **generic over the gRPC transport**, so
the browser (gRPC-web over `fetch`) and the native integration test (plain gRPC over
`tonic::transport::Channel`) run the same code against mainnet. That is deliberate: the
sequence that spends real money is exercised natively before a browser is pointed at it.
The transport-free half — addresses, fees, witness replay, keys, build and prove — is
`src/spend.rs` and is unit-tested without a network.

### Building the transaction

```rust
Builder::new(
    network,                      // MAIN_NETWORK for a mainnet sweep
    target_height,                // chain tip + 1
    BuildConfig::Standard {
        sapling_anchor:   None,   // never: see NoSaplingProver below
        orchard_anchor:   None,   // ZIP 258 forbids new value entering the Orchard pool
        ironwood_anchor:  Some(anchor),
        orchard_padding:  BundlePadding::DEFAULT,
        ironwood_padding: BundlePadding::DEFAULT,
    },
)
.add_ironwood_spend(fvk, note, merkle_path)?   // once per note; each MUST be NoteVersion::V3
.add_ironwood_output(Some(ovk), addr, value, memo)?   // a UA with an Orchard receiver
// or .add_transparent_output(&t_addr, value)?        // a t1/t3 address
.build(
    &TransparentSigningSet::default(),
    &[],                          // no Sapling extended spending keys
    &[ask],                       // the Orchard spend authorizing key
    OsRng,
    &NoSaplingProver,
    &NoSaplingProver,
    &zip317::FeeRule::standard(),
)
```

`zcash_primitives` 0.30.1 with features `circuits` + `std`. `circuits` is what makes
`build` exist at all and what pulls the Orchard/Ironwood halo2 circuit into the wasm;
`std` is what gives `build` the process-wide proving-key cache described below.

`zcash_primitives`' own `multicore` stays **off**; this crate turns on
`orchard/multicore` directly, through its own `multicore` feature, which is the M4
threaded build. See **Two wasm packages** below.

**`circuits` cannot be narrowed.** It is defined as `["orchard/circuit",
"sapling/circuit"]`, and `Builder::build` — the only entry point that can produce a
transaction — is `#[cfg(feature = "circuits")]`. Cargo features are additive, so there is
no way to ask for the Orchard half without the Sapling half: taking `circuits` takes
bellman and groth16 with it, even though [`NoSaplingProver`](#nosaplingprover) means no
Groth16 proof is ever created. Splitting the feature upstream would need a
`[patch.crates-io]` fork of `zcash_primitives`, which this crate does not do (same reason
as in **Warming the proving key** below: it forks a consensus-critical crate). The cost
of not doing it is small and was measured: the shipped wasm contains no `bellman` or
`groth16` symbols at all, because nothing reachable from `build::<_, NoSaplingProver,
NoSaplingProver, _>` calls them and LTO plus `wasm-ld` drop the lot.

### Two wasm packages

`scripts/build-core.sh` builds this crate **twice**:

| | `web/src/wasm/core` | `web/src/wasm/core-mt` |
| --- | --- | --- |
| features | default | `multicore` |
| toolchain | the default stable one | nightly, `-Z build-std=std,panic_abort` |
| memory | its own, exported | **imported and shared**, max 2 GB |
| needs | nothing | a cross-origin-isolated page |
| proving | one thread | a `wasm-bindgen-rayon` pool |

`multicore` turns on `orchard/multicore`, which is what puts rayon inside halo2's MSM and
FFT, and links `wasm-bindgen-rayon` so the browser can give that rayon real threads. The
threaded module imports a *shared* memory, so it only instantiates where
`SharedArrayBuffer` exists; that is why both packages ship and `web/src/core/worker.ts`
feature-detects between them, falling back to the single-threaded one on any failure.

Two extra exports exist for that loader, in both packages:

| Export | |
| --- | --- |
| `is_threaded()` | `() => boolean` — the build stamp: true only in the `multicore` package |
| `thread_count()` | `() => number` — `rayon::current_num_threads()`, or 1. Meaningful only after `initThreadPool` has resolved |

and the `multicore` package additionally exports `wasm-bindgen-rayon`'s
`initThreadPool(n) -> Promise`, which must be awaited on the thread that instantiated the
module, after `init()` and before anything proves.

The Ironwood spend refuses a note that is not `NoteVersion::V3`. That is the type system
restating the pool split from M2: an Orchard (V2) note cannot be spent into an Ironwood
bundle, and the note the envelope received is V3 because `IronwoodDomain` is what
decrypted it.

### `NoSaplingProver`

`build` is generic over a Sapling spend prover and a Sapling output prover and wants a
value of each, even when no Sapling bundle is built. A Sapling bundle is built **only**
when `BuildConfig::Standard` carries a `sapling_anchor`, and ours never does, so the
provers are never called. `NoSaplingProver` is a zero-sized type whose every method is
`unreachable!()`: it satisfies the type and aborts loudly if that invariant is ever
broken.

The alternative is the real `SpendParameters`, which means shipping the 51.5 MB Sapling
proving parameters to a browser — exactly what [D2](../../docs/DECISIONS.md) rules out,
and `download.z.cash` does not serve them cross-origin anyway. A unit test asserts both
provers abort and that the type is zero-sized; the native integration test asserts the
built transaction has no Sapling bundle at all.

### The witness

Ironwood shares Orchard's tree: `MerkleHashOrchard` nodes, depth 32. The recipe, verified
against mainnet before it was written into this crate. `h` is the **earliest** note's
block:

1. `GetTreeState(h − 1).ironwood_tree()` → the frontier just before that block.
2. `GetBlock(h)` → append **every** `ironwood_actions[].cmx` in the block, in (tx index,
   action index) order, which is the order the chain commits them in. Take
   `IncrementalWitness::from_tree` immediately after each of our own commitments is
   appended, then keep appending the rest to every witness as well as to the tree.
3. Compare the replayed root against `GetTreeState(h)`'s. A mismatch is a **hard error**:
   it means the replay saw a different set of commitments than the chain did, and a proof
   built on it would be rejected. There is no fallback, because a wrong anchor is not a
   degraded sweep, it is a lost one.
4. Keep streaming later blocks into the tree and into every witness taken so far (see the
   anchor policy), taking a new witness as the replay reaches each later note's
   commitment, and repeating step 3's comparison at **each** block that holds a note.
   Compare against `GetTreeState(anchor height)` again before using the result.
5. `anchor = witness.root()`, one `merkle_path = witness.path()` per note.

#### Several notes, one anchor

`WitnessScan` holds a table of witnesses, one slot per note, rather than a single one:

- **Notes in the same block** are witnessed in one pass over that block, at their own
  leaves. They share the tree replay and cost nothing extra.
- **Notes in different blocks** are witnessed as the replay reaches each of their blocks.
  The tree the replay holds when it arrives at a later note's block *is* that block's
  `h − 1` frontier — arrived at by replaying rather than by fetching it again — which is
  why one continuous replay from the earliest note's block is both correct and the
  cheapest thing available: every witness has to see every commitment after its own leaf
  anyway.
- Every witness keeps absorbing later commitments, so at the anchor they **all root to
  the same anchor**. `finish` checks that, note by note, against the root the server
  reports, and refuses the whole sweep if any one of them disagrees.

No `shardtree`, no wallet database, no subtree roots: the witnesses are computed on
demand from data the server already serves and thrown away afterwards.

### Anchor policy

Zebra accepts a spend against the root of **any** finalized Ironwood tree state, not just
a recent one, which gives two valid strategies:

| | Cost | What the anchor reveals |
| --- | --- | --- |
| **Same-block anchor** — witness in the note's own block and stop | one `GetTreeState` + one `GetBlock`, constant | the note's block, which anyone who already knows the funding transaction knows |
| **Recent anchor** — roll the witness forward to the chain tip | one streamed block per block of distance | nothing about the note's age; this is what an ordinary wallet does |

The policy takes the middle of the two, bounded by `ANCHOR_WALK_CAP` (**24 blocks**,
about half an hour of mainnet at 75 s per block):

```
anchor = min(tip, newest note height + ANCHOR_WALK_CAP)
```

A recipient opening a link minutes after it was funded — the normal case — still gets the
chain tip, because the tip is then the smaller of the two and nothing changes for them. An
older envelope gets an anchor 24 blocks past its newest note instead of the tip, and the
walk is bounded there rather than growing with the envelope's age. The height used comes
back as `anchor_height`.

**This is a privacy/latency trade-off, not a correctness one** (DECISIONS.md D18). Any
finalized tree state's root is a consensus-valid anchor — the M3 spike verified a
same-block anchor against mainnet, which is the extreme case of the same thing — so no
cap, of any size, can produce a transaction the chain will not take. The walk is
therefore there for one purpose only: so the anchor does not pin the exact funding block.
Any distance past the note buys that, and each block of it is paid for in Sinsemilla
hashing on the recipient's device — **24 blocks is about 2 s on a desktop and under 1 s
on a recent phone, where 120 blocks cost about 10 s** (web/docs/PERF-2026-09-21.md §9 and
§10). What the cap costs is anonymity-set freshness: an observer reading the anchor of an
old envelope's sweep learns the transaction was built against a tree state no later than
`note + 24`, a narrower window than "somewhere near the tip". What it buys is a witness
stage that does not grow without bound: before the cap, a 777-block-old envelope replayed
all 777 blocks and a month-old one would have replayed about 35,000.

The correctness checks are untouched by the cap. The replayed root is still compared
against the server's `GetTreeState` at every note block, and the anchor root is still the
server's own, taken at whatever height the rule above picked.

With several notes the rule reads off the **youngest** note, since the anchor must be at
or after all of them. The replay still starts at the **oldest** note's block, because that
witness has the furthest to travel.

### ZIP-317 fee

A sweep has one Ironwood spend per note. The Ironwood pool **permits cross-address
transfers**, so a requested spend and a requested output share an action and the count is
`max(spends, outputs)`, padded up to the 2-action minimum. (The Orchard pool under
NU6.3 mandates the cross-address restriction and would charge `spends + outputs`; Ironwood
does not.) Transparent outputs are charged by total serialized bytes over ZIP-317's
standard 34-byte P2PKH output, and the first two logical actions are free of marginal fee.

| Notes | Outputs | Logical actions | Network fee |
| --- | --- | --- | --- |
| 1 | 1 shielded (flat fee of 0) | 2 | 10,000 zat |
| 1 | 2 shielded (destination + flat fee) | 2 | 10,000 zat |
| 1 | 1 shielded + 1 transparent | 3 | 15,000 zat |
| 2 | 2 shielded | 2 | 10,000 zat |
| 3 | 2 shielded | 3 | 15,000 zat |
| 3 | 1 shielded + 1 transparent | 4 | 20,000 zat |

So a **second note costs nothing**: it rides in an action the outputs had already paid
for. Only the third and beyond add a marginal fee each — which is still far less than
sweeping them one transaction at a time, where every sweep pays the 10,000 minimum again.

The arithmetic is `ironwood_action_count` and `network_fee_zat` in `src/spend.rs`,
unit-tested against each shape. It is the same arithmetic
`orchard::builder::BundleType::num_actions` does for the bundle the builder emits, and it
is checked again at build time: `build` refuses a transaction whose value balance is not
exactly zero after fees, so a wrong fee is a build error and never a silent overpayment.

### Where a sweep can send

| Destination | `classify_address` kind | Swept to |
| --- | --- | --- |
| unified with an Orchard receiver, `u1…` | `unified_orchard` | an Ironwood output — **yes** |
| transparent, `t1…` or `t3…` | `transparent` | a transparent output — **yes**, and the amount becomes public |
| unified without an Orchard receiver | `unified_no_orchard` | refused |
| Sapling, `zs1…` | `sapling` | refused — **no** |
| anything else, or an address for the other network | `invalid` | refused |

`classify_address` never throws: an unparseable string, a testnet address on mainnet and a
TEX address all come back as a kind plus a `reason` the recipient can read. Sapling is
refused for the same reason `NoSaplingProver` exists: paying it would need the Sapling
proving parameters. A recipient with only a `zs1…` address is told so, rather than having
their money sent somewhere the flow cannot reach.

### Warming the proving key

`zcash_primitives` builds its own Orchard/Ironwood proving key **inside** `build`, caching
it in a process-wide `OnceLock` keyed by circuit version
(`transaction::builder::cached_orchard_proving_key`, which that crate exports as a
`pub fn`). Left alone, the recipient pays for that key build — about 27 s of
single-threaded wasm — inside the same call that proves, with no way to tell the two apart
on screen.

`warm_proving_key()` forces it early and returns the milliseconds it took. Three ways to
do that were considered:

1. **A `[patch.crates-io]` fork of `zcash_primitives`** adding an entry point that touches
   the `OnceLock`. **Rejected**: it forks a consensus-critical crate to reach something
   that is already public.
2. **Building a throwaway bundle** so `build` populates the cache as a side effect.
   **Rejected**: it costs a whole proof (tens of seconds) on top of the key build, and
   needs a fabricated note and anchor.
3. **Calling `cached_orchard_proving_key(OrchardCircuitVersion::PostNu6_3)` directly.**
   **Taken.** It is `pub`, it is the very `OnceLock` the real build path reads, and it
   costs the key build and nothing else.

A second call returns in ~0 ms, which the browser test asserts. The circuit version is
pinned to `PostNu6_3`, the version every Ironwood bundle proves against; a key built for
another version would produce proofs against the wrong key.

### Broadcasting, and the `error_code` trap

**`SendTransaction` answers a rejected transaction with gRPC status 0, OK.** The rejection
is in `SendResponse.error_code` (0 means accepted) and `SendResponse.error_message`. A
client that only checks the gRPC status reports a rejected sweep as a successful one and
tells the recipient their money has moved when it has not.

`sweep` checks the field: a nonzero `error_code` rejects the promise with the server's own
`error_message`, and the code and message are also carried out on the result object so a
caller can show them. With `broadcast: false` nothing is sent at all, `raw_tx_hex` comes
back for inspection, and `error_code` and `error_message` are `null`.

### A fresh wallet for the recipient

`new_wallet(network, birthday)` is for a recipient who has no Zcash address at all: 24
English BIP-39 words (`bip0039`), seed = `mnemonic.to_seed("")` — the full 64 bytes with
an **empty passphrase** — then `UnifiedSpendingKey::from_seed`, account 0, and a unified
address with Orchard and Sapling receivers (`UnifiedAddressRequest::SHIELDED`).

The empty passphrase and the 64-byte seed are what Zodl (formerly Zashi) and
`zcash-devtool` do, which is the whole point of the choice: these words can be typed into
either and the same account comes back. [TEST_VECTORS.md](TEST_VECTORS.md) records the
address for a fixed mnemonic so an import can be checked by hand.

### Measured

Mainnet, the real M1 envelope (130,000 zat, tx `281e9f7b…341d43`, block 3490472), swept to
a fresh wallet with a 30,000 zat flat fee. Neither run broadcast anything.

| | Native (release, `zec.rocks:443`) | Browser (Playwright chromium, `zjs.zec.rocks`) |
| --- | --- | --- |
| witness | 1.5 s | ~3 s |
| keys | 0.02 s | < 0.1 s |
| proving key | included in proving | **27.4 s** (`warm_proving_key`, second call 0 ms) |
| proving | 23.7 s (key build included) | 42 s |
| raw transaction | **9,166 bytes** | 9,166 bytes |
| total | 25.2 s | 72.7 s including the key build |

Both produce a V6 transaction with **2 Ironwood actions**, no Sapling bundle, no Orchard
bundle and no transparent bundle. The wasm is 2.18 MB raw, 1.03 MB gzipped.

The M1 envelope holds one note, so its sweep is a one-element array and the transaction is
byte for byte what it was before sweeps could spend several notes. Both tests assert the
**9,166 bytes** rather than only printing it, so a change to the transaction cannot pass
unnoticed.

## JS API

All exports throw a **plain string** on failure, not an `Error`. Catch with
`catch (e) { /* e is a string */ }`.

```js
import init, * as core from "./wasm/core/zenvelope_core.js";
await init();

const secret = core.generate_secret();
// "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA"

const { address, ufvk, diversifier_index } = core.derive(secret, "main");

const fragment = core.build_fragment(secret, 3490400);
const { secret: s, birthday } = core.parse_fragment(location.hash);

const uri = core.payment_uri(address, 10_000n + 100_000n, "Coffee");
// "zcash:u1...?amount=0.0011&memo=Q29mZmVl"
```

| Export | Signature |
| --- | --- |
| `derive` | `(secret_b64url: string, network: "main" \| "test") => { address: string, ufvk: string, diversifier_index: number }` |
| `generate_secret` | `() => string` — 43 base64url chars from the CSPRNG |
| `parse_fragment` | `(fragment: string) => { secret: string, birthday?: number }` |
| `build_fragment` | `(secret: string, birthday?: number) => string` |
| `payment_uri` | `(address: string, amount_zat: bigint \| string \| number, memo?: string) => string` — `memo` is the sender's text, base64url'd into the ZIP-321 `memo=` parameter |
| `memo_byte_length` | `(text: string) => number` — UTF-8 bytes, which is what the 512-byte limit counts |
| `max_memo_bytes` | `() => number` — 512 |
| `zat_to_zec_string` | `(zat: bigint \| string \| number) => string` |
| `zec_string_to_zat` | `(zec: string) => bigint` |
| `is_orchard_only` | `(address: string) => boolean` — decodes the address and confirms one receiver, Orchard |
| `open_envelope` | `(secret: string, birthday: number \| undefined, network: "main" \| "test", lightwalletd_url: string, on_progress?: (scanned: number, total: number, event?: ScanEvent) => void) => Promise<Opened>` |
| `classify_address` | `(address: string, network: "main" \| "test") => { kind: Kind, reason: string \| null }` — never throws on a bad address |
| `new_wallet` | `(network: "main" \| "test", birthday: number) => { mnemonic: string, address: string, ufvk: string, birthday: number }` |
| `warm_proving_key` | `() => Promise<number>` — builds the Ironwood proving key now; resolves with the milliseconds it took |
| `is_threaded` | `() => boolean` — true only in the `multicore` package |
| `thread_count` | `() => number` — threads in the proving pool; 1 until `initThreadPool` resolves |
| `initThreadPool` | `(n: number) => Promise<void>` — **`multicore` package only** |
| `sweep_envelope` | see below |

From M4 the web app never calls these on its main thread: they are reached over a
message protocol from `web/src/core/worker.ts`, and every one of them is a promise on the
page's side. The signatures above are the wasm's own, which is what the worker sees.

The `Opened` object below is the field-for-field contract `web/src/core/types.ts`
declares, including `birthday`, `birthday_defaulted` and `scanned_blocks`.

```ts
interface Opened {
  found: boolean;            // ever received anything, spent or not
  all_spent: boolean;        // found, and every note already spent
  notes: Array<{
    amount_zat: string;      // zatoshi, decimal string: never an f64
    memo: string | null;     // text memos only; empty and non-text memos are null
    height: number;
    txid: string;            // big-endian, as block explorers print it
    pool: "ironwood" | "orchard" | "sapling";
    action_index: number;    // which action in that pool's list is ours; M3 needs it
    spent: boolean;          // its nullifier was seen on chain
    spent_txid: string | null;
    spent_height: number | null;
    spent_time: number | null; // unix seconds, from the spending block's header
  }>;
  total_zat: string;         // unspent notes only
  spent_zat: string;         // spent notes
  tip_height: number;
  birthday: number;          // the height the scan actually started at
  birthday_defaulted: boolean; // true when `birthday` was undefined and tip-10000 was used
  scanned_blocks: number;
}
```

`open_envelope` rejects with a plain string like every other export. `on_progress` is
optional and anything it throws is ignored: a scan must not die because a progress bar
did. Its third argument is `{ kind: "progress", phase: "find" | "verify" }` with every
count, and once, when the birthday block held the envelope's notes,
`{ kind: "note", phase: "verify", notes, total_zat, spent_zat, tip_height, birthday }`,
`notes` shaped exactly as in the result. A note from that event may still turn out spent
when the walk reaches the tip; the result is the answer.

### `classify_address` and `new_wallet`

```js
const { kind, reason } = core.classify_address(pasted, "main");
// kind: "unified_orchard" | "unified_no_orchard" | "sapling" | "transparent" | "invalid"
// reason: null when the sweep can pay it, otherwise a sentence to show the recipient

const wallet = core.new_wallet("main", tipHeight);
// { mnemonic: "24 words…", address: "u1…", ufvk: "uview1…", birthday: tipHeight }
```

`classify_address` does not throw: see [Where a sweep can send](#where-a-sweep-can-send).
`new_wallet`'s `mnemonic` is the money — it exists only in the page, and showing it is the
caller's decision.

### `sweep_envelope`

```ts
core.sweep_envelope(
  secret: string,
  network: "main" | "test",
  lightwalletd_url: string,
  // every note from open_envelope; a bare object is accepted for one release
  notes: Array<{ txid: string; height: number; action_index: number }>,
  destination: string,
  fee_address: string,
  fee_zat: string,          // decimal zatoshi; "0" means one output and no fee address
  memo: string | null,      // goes on the destination output
  broadcast: boolean,       // false builds and proves without sending
  on_stage: (stage: Stage, detail: string) => void,
): Promise<SweepResult>

type Stage = "witness" | "keys" | "proving" | "broadcast" | "done";

interface SweepResult {
  txid: string;
  raw_tx_hex: string | null;          // always present when broadcast was false
  amount_to_destination_zat: string;  // zatoshi, decimal string
  fee_zat: string;
  network_fee_zat: string;
  anchor_height: number;
  broadcast: boolean;
  error_code: number | null;          // SendResponse.error_code; 0 means accepted
  error_message: string | null;
}
```

The stages fire in that order; `witness` may fire more than once while the witnesses roll
forward. Anything `on_stage` throws is ignored, for the same reason `on_progress`'s is.

`notes` is an **array**, and every note in it is spent in the one transaction:
`amount_to_destination_zat` is their sum minus both fees. A bare
`{ txid, height, action_index }` object is still accepted and treated as a one-element
array — backward compatibility for **one release**, so a page built against the M3
signature keeps working; new callers pass the array. An empty array is refused, and so is
the same note twice, before any network work.

Every note is **re-derived from the secret**, not trusted: `sweep_envelope` fetches each
funding transaction and decrypts `ironwood_actions[action_index]` itself, and fails if it
does not decrypt with this link's viewing key. Two notes that arrived in the *same*
funding transaction cost one fetch, not two.

`fee_zat` crosses as a decimal string, like every other amount. `"0"` builds a single
output and never looks at `fee_address`, so a caller that is not charging a fee need not
supply one.

`amount_zat` on `payment_uri` accepts a `BigInt`, a decimal string, or a number. A number
above `Number.MAX_SAFE_INTEGER` is rejected rather than silently rounded; pass a `BigInt`
or a string for large amounts. `zec_string_to_zat` returns a `BigInt`, and rejects
anything finer than one zatoshi rather than rounding it away.

`derive`, `classify_address` and `new_wallet` return wasm-bindgen objects. Read their
fields, then `free()` them (or use `using` / `Symbol.dispose`) if you are calling them in
a loop.

## Building

```sh
./scripts/build-core.sh
```

Runs `wasm-pack build crates/core --target web --release` into `web/src/wasm/core/`,
then prints the raw and gzipped size. Requires the `wasm32-unknown-unknown` target,
`wasm-pack`, and `clang` (the transparent dependency chain pulls in `secp256k1-sys`,
which builds C even though this crate never calls it).

The M3 wasm is **2.18 MB raw, 1.03 MB gzipped**, up from a few hundred KB at M2. The
Orchard/Ironwood halo2 circuit is most of it; `circuits` also switches on `sapling/circuit`
(bellman and groth16) because `zcash_primitives` has no feature that selects one without
the other. Sapling proving *parameters* are a separate matter and are never downloaded —
see [`NoSaplingProver`](#nosaplingprover).

`tonic-web-wasm-client` and `wasm-bindgen-futures` are scoped to the wasm target, and
`src/grpc.rs` is `cfg`-gated to match, so a native `cargo test` builds and runs the scan
and sweep logic without any browser-only dependency. The native gRPC transport is the
mirror image: it is a **dev** dependency, so it is in the integration test and not in the
shipped wasm.

`.cargo/config.toml` sets `--cfg getrandom_backend="wasm_js"` for the wasm target;
`getrandom` 0.3 will not compile for `wasm32-unknown-unknown` without it. There is a
*second* `getrandom` in the tree — 0.2, reached through `rand` 0.8 by the Orchard circuit
— which takes its backend from a feature instead, so `crates/core/Cargo.toml` also names
`getrandom = { version = "0.2", features = ["js"] }` for wasm. Neither covers the other.
The `[package.metadata.wasm-pack.profile.release]` block names the post-MVP wasm features
rustc emits, which the bundled `wasm-opt` otherwise rejects.

## Testing

```sh
cargo test -p zenvelope-core        # unit tests
node scripts/smoke-core.mjs         # loads the built wasm and asserts the vectors
```

The unit tests cover derivation determinism, the one-Orchard-receiver invariant on both
networks, fragment round-trips, ZIP-321 amount formatting and parsing edge cases, amount
overflow, and for M2 the scan range rules (birthday given, defaulted, clamped past the
tip), memo rendering, the ZIP-321 memo round trip (base64url in, the sender's text back
out) and its 512-byte limit, pool naming, total overflow, endpoint normalisation, the
Orchard-only shape of the scan keys, and that a compact block of actions that are not ours
decrypts to nothing.

For M3 they cover the whole destination matrix (including a wrong-network address and
nonsense that must classify rather than throw), each fee shape, the note-splitting
arithmetic and its refusal to build a sweep that cannot pay for itself, that both halves
of `NoSaplingProver` abort and that it is zero-sized, mnemonic → unified address
determinism against a fixed vector recorded in [TEST_VECTORS.md](TEST_VECTORS.md), the
BIP-39 seed for that vector, that the spending key matches the viewing key the scan uses,
the anchor policy at every boundary, txid byte-order conversion, and the witness replay:
that a witness is taken at the target action and nowhere else, and that a root mismatch is
a hard error.

The multi-note bookkeeping is unit-tested against **synthetic trees**, because it cannot
be tested against the chain: the funded M1 envelope holds one note, and using it twice
would be a duplicate nullifier rather than a two-note sweep. Those tests replay hand-built
compact blocks and assert that two notes in **one** block are witnessed in one pass at
their own leaves, that two notes in **different** blocks are each witnessed as the replay
reaches them, that in both cases every witness roots to the **same anchor** once the
replay reaches it, that a note the replay never passed is named rather than silently
dropped, and that one commitment cannot fill two slots. The fee arithmetic is tested at
one, two, three and four spends, shielded and transparent.

The Node smoke test loads the actual `--target web` artifact and checks that `derive()`
reproduces the Rust vectors byte for byte, plus the M3 exports `classify_address` and
`new_wallet`.

### Against mainnet

Two live proofs, both of which **build and prove a real sweep and never broadcast it**.
Both need the funded link secret, which is never committed, so both read it from the
environment and skip cleanly without it. The destination and fee addresses come from the
private, gitignored `M3-DEST.md`.

```sh
export ZENV_M1_FRAGMENT='<secret>.<birthday>'
export ZENV_M3_DEST_ADDRESS='u1…'
export ZENV_M3_FEE_ADDRESS='u1…'

# native: the same sweep() over plain gRPC to zec.rocks:443
cargo test -p zenvelope-core --release --test m3_sweep -- --ignored --nocapture

# browser: the built wasm on a cross-origin-isolated page
cd web && npm run e2e -- e2e/m3-core.spec.ts
```

`--release` is not optional for the native one in practice: the halo2 proof takes minutes
in a debug build and seconds in a release one.

The native test (`crates/core/tests/m3_sweep.rs`) passes the M1 note as a **one-element
array**, and asserts the stages fire in order, that every zatoshi of the note is accounted
for, that the transaction is still **9,166 bytes**, and that the raw bytes parse back with
`Transaction::read` as **V6 with 2 Ironwood actions**, no Sapling bundle, no Orchard
bundle and no transparent bundle. It prints per-stage timings and the transaction size.
Two further tests in that file need neither the network nor the secret: that the same note
twice is refused before any network work, and that several notes are charged by action
count.
It also carries two by-hand tools: `locate_the_m1_note`, which reports which Ironwood
action of a transaction decrypts, and `mint_m3_destination`, which generated the wallet
and fee envelope in `M3-DEST.md`.

The browser test (`web/e2e/m3-core.spec.ts`) times `warm_proving_key`, asserts a second
call is nearly free, runs the same sweep through the wasm in the **array** form with
`broadcast: false`, and checks the stage order, the amounts and the raw transaction —
including that it is still 9,166 bytes. A second, cheap test asserts the wasm refuses an
empty array and the same note twice, which is the JS boundary's own array handling. The M2 browser proof
(`web/e2e/m2-core.spec.ts`) is unchanged.

Fixed vectors live in [TEST_VECTORS.md](TEST_VECTORS.md) so the web app can assert
against them. Regenerate with:

```sh
cargo test -p zenvelope-core -- --ignored --nocapture print_test_vectors
cargo test -p zenvelope-core -- --ignored --nocapture print_m3_test_vectors
```
