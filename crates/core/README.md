# zenvelope-core

The key-derivation core. A link secret in, a shielded Zcash address and a ZIP-321
payment URI out. Compiled to WASM for the browser; usable as a plain Rust crate for
tests and tooling.

Nothing here touches the network. Nothing here writes to disk. The secret is an argument
and a return value, never state.

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

The crate is built with `zcash_keys`'s `orchard` feature only. Sapling and
`transparent-inputs` are off, so there is no code path that could produce either
receiver even if a request asked for one.

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

`.cargo/config.toml` sets `--cfg getrandom_backend="wasm_js"` for the wasm target;
`getrandom` 0.3 will not compile for `wasm32-unknown-unknown` without it. The
`[package.metadata.wasm-pack.profile.release]` block names the post-MVP wasm features
rustc emits, which the bundled `wasm-opt` otherwise rejects.

## Testing

```sh
cargo test -p zenvelope-core        # unit tests
node scripts/smoke-core.mjs         # loads the built wasm and asserts the vectors
```

The unit tests cover derivation determinism, the one-Orchard-receiver invariant on both
networks, fragment round-trips, ZIP-321 amount formatting and parsing edge cases, and
amount overflow. The Node smoke test loads the actual `--target web` artifact and checks
that `derive()` reproduces the Rust vectors byte for byte.

Fixed vectors live in [TEST_VECTORS.md](TEST_VECTORS.md) so the web app can assert
against them. Regenerate with:

```sh
cargo test -p zenvelope-core -- --ignored --nocapture print_test_vectors
```
