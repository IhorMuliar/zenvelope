# zenvelope-core

The envelope core. A link secret in, a shielded Zcash address and a ZIP-321 payment URI
out (M1), and the notes that address received (M2). Compiled to WASM for the browser;
usable as a plain Rust crate for tests and tooling.

Nothing here writes to disk, and no key is ever state: the secret is an argument and a
return value. Key derivation and ZIP-321 stay offline. The one export that reaches the
network is `open_envelope`, and it talks only to the lightwalletd gateway the caller
names.

**This file is the contract M2 and M3 build on.** If an implementation and this document
disagree, the disagreement is a bug in one of them, and the fix goes in both.

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
and it is not part of the derivation.

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
zcash:<address>?amount=<ZEC>[&message=<percent-encoded>]
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

Amounts of zero, and amounts above `MAX_MONEY` (2.1e15 zatoshi), are rejected. `message`
is percent-encoded to the ZIP-321 `qchar` set, so a space becomes `%20` and an `&`
becomes `%26` and cannot split the query into extra parameters.

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
`https://zcash-mainnet.chainsafe.dev` (D3). Progress is reported every 100 blocks and
once at each end of the range.

Scanning starts at the birthday in the link fragment. Without one it starts at
`tip - 10000` (about eight days of mainnet) and says so in the result, via
`birthday_defaulted`. A birthday above the tip is clamped to the tip rather than
rejected: a link made seconds ago can legitimately name a height the server has not
served yet.

Measured on 2026-09-20 against `zjs.zec.rocks`, Playwright chromium, the funded M1
envelope: **57 blocks in 1.8 s wall**, tip included, from a cold page.

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

### Memory footprint

The scan holds one compact block at a time plus a set of hits, and nothing else. There is
no block cache, no note commitment tree, no database: peak usage is the wasm linear
memory (a few MB, growing with the largest block seen) and is flat in the number of
blocks scanned. A 10,000-block default scan and a 57-block scan cost the same memory.
Nothing is persisted, so closing the tab leaves nothing behind — which is the privacy
property the product wants anyway.

### What M3 will need

M2 deliberately stops at "what did this envelope receive". Spending needs three things
this path does not produce:

- **Note positions and witnesses.** Trial decryption alone gives no position in the
  Ironwood commitment tree. M3 has to track commitment tree state, which means
  `zcash_client_backend::scanning::scan_block` (it returns `ScannedBlock` with positions
  and takes the `ChainState` from `GetTreeState`) plus a `shardtree` to hold the
  frontier.
- **A `WalletRead`/`WalletWrite` store.** The obvious candidate, `zcash_client_memory`,
  is **not usable**: it was removed from the librustzcash workspace on 2026-06-20 and now
  lives at <https://github.com/zcash/zcash_client_memory>, pinned to
  `zcash_client_backend` 0.23 / `orchard` 0.14 with zero Ironwood support (`grep -i
  ironwood src` finds nothing). It is not published on crates.io either. Bringing it to
  0.24 means implementing the whole Ironwood half of `WalletRead`/`WalletWrite`,
  including a second shard tree and the Ironwood subtree roots. Until someone does, the
  M3 options are: port it, or keep the store minimal and Ironwood-only, which is enough
  for one account holding one note.
- **Proving.** Unchanged from D8.

What M3 *can* reuse as-is: the key derivation (`ufvk_from_secret` gives the Orchard-only
UFVK, and the spending key comes from the same seed), the gRPC-web transport and its
generated client, the compact-block Ironwood decryption, and the full-transaction
decryption that produces the note itself.

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
// "zcash:u1...?amount=0.0011&message=Coffee"
```

| Export | Signature |
| --- | --- |
| `derive` | `(secret_b64url: string, network: "main" \| "test") => { address: string, ufvk: string, diversifier_index: number }` |
| `generate_secret` | `() => string` — 43 base64url chars from the CSPRNG |
| `parse_fragment` | `(fragment: string) => { secret: string, birthday?: number }` |
| `build_fragment` | `(secret: string, birthday?: number) => string` |
| `payment_uri` | `(address: string, amount_zat: bigint \| string \| number, message?: string) => string` |
| `zat_to_zec_string` | `(zat: bigint \| string \| number) => string` |
| `zec_string_to_zat` | `(zec: string) => bigint` |
| `is_orchard_only` | `(address: string) => boolean` — decodes the address and confirms one receiver, Orchard |
| `open_envelope` | `(secret: string, birthday: number \| undefined, network: "main" \| "test", lightwalletd_url: string, on_progress?: (scanned: number, total: number) => void) => Promise<Opened>` |

```ts
interface Opened {
  found: boolean;
  notes: Array<{
    amount_zat: string;      // zatoshi, decimal string: never an f64
    memo: string | null;     // text memos only; empty and non-text memos are null
    height: number;
    txid: string;            // big-endian, as block explorers print it
    pool: "ironwood" | "orchard" | "sapling";
  }>;
  total_zat: string;
  tip_height: number;
  birthday: number;          // the height the scan actually started at
  birthday_defaulted: boolean; // true when `birthday` was undefined and tip-10000 was used
  scanned_blocks: number;
}
```

`open_envelope` rejects with a plain string like every other export. `on_progress` is
optional and anything it throws is ignored: a scan must not die because a progress bar
did.

`amount_zat` accepts a `BigInt`, a decimal string, or a number. A number above
`Number.MAX_SAFE_INTEGER` is rejected rather than silently rounded; pass a `BigInt` or a
string for large amounts. `zec_string_to_zat` returns a `BigInt`, and rejects anything
finer than one zatoshi rather than rounding it away.

`derive` returns `DerivedAddress`, a wasm-bindgen object. Read its fields, then `free()`
it (or use `using` / `Symbol.dispose`) if you are deriving in a loop.

## Building

```sh
./scripts/build-core.sh
```

Runs `wasm-pack build crates/core --target web --release` into `web/src/wasm/core/`,
then prints the raw and gzipped size. Requires the `wasm32-unknown-unknown` target,
`wasm-pack`, and `clang` (the transparent dependency chain pulls in `secp256k1-sys`,
which builds C even though this crate never calls it).

`tonic-web-wasm-client` and `wasm-bindgen-futures` are scoped to the wasm target, and
`src/grpc.rs` is `cfg`-gated to match, so a native `cargo test` builds and runs the scan
logic without any browser-only dependency.

`.cargo/config.toml` sets `--cfg getrandom_backend="wasm_js"` for the wasm target;
`getrandom` 0.3 will not compile for `wasm32-unknown-unknown` without it. The
`[package.metadata.wasm-pack.profile.release]` block names the post-MVP wasm features
rustc emits, which the bundled `wasm-opt` otherwise rejects.

## Testing

```sh
cargo test -p zenvelope-core        # unit tests
node scripts/smoke-core.mjs         # loads the built wasm and asserts the vectors
```

The browser proof for M2 is `web/e2e/m2-core.spec.ts`. It loads the built wasm on a
cross-origin-isolated page and opens the real funded mainnet envelope, asserting the note
against what the zcash-devtool oracle reports. It needs the link secret, which is never
committed, so it reads `ZENV_M1_FRAGMENT` at run time and skips cleanly without it:

```sh
cd web && ZENV_M1_FRAGMENT='<secret>.<birthday>' npm run e2e
```

The unit tests cover derivation determinism, the one-Orchard-receiver invariant on both
networks, fragment round-trips, ZIP-321 amount formatting and parsing edge cases, amount
overflow, and for M2 the scan range rules (birthday given, defaulted, clamped past the
tip), memo rendering, pool naming, total overflow, endpoint normalisation, the
Orchard-only shape of the scan keys, and that a compact block of actions that are not
ours decrypts to nothing. The Node smoke test loads the actual `--target web` artifact and checks
that `derive()` reproduces the Rust vectors byte for byte.

Fixed vectors live in [TEST_VECTORS.md](TEST_VECTORS.md) so the web app can assert
against them. Regenerate with:

```sh
cargo test -p zenvelope-core -- --ignored --nocapture print_test_vectors
```
