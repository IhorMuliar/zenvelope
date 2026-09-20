# M1 verification

Evidence that the web app runs the real `zenvelope-core` WASM build, that the addresses
it produces are valid mainnet Zcash unified addresses, and that an independent reference
client accepts the viewing key the browser derived.

Run on 2026-09-20. Everything below is a transcript of commands that were actually
executed, not a description of what they would do.

- Repo: `/root/Projects/web3-sweep/zenvelope`, branch `main`
- Oracle: `zcash-devtool` @ `5a26ee854e634a4e88d1d79dab13f8fbb1eac6b8`
  (see `/root/Projects/web3-sweep/tools/DEVTOOL.md`)
- Network: **mainnet**. No funds were sent as part of this verification; the oracle
  wallet is view-only and its balance is zero by construction.

## 1. The WASM build

```sh
./scripts/build-core.sh
cargo test -p zenvelope-core
node scripts/smoke-core.mjs
```

| | |
| --- | --- |
| Output | `web/src/wasm/core/{zenvelope_core.js, zenvelope_core_bg.wasm, *.d.ts}` |
| wasm, raw | **435,317 bytes** (425 KB) |
| wasm, gzip | 259,653 bytes (253 KB) |
| wasm-bindgen | 0.2.128, `--target web`, `wasm-opt -Oz` |
| `cargo test -p zenvelope-core` | 22 passed, 0 failed, 1 ignored |
| `node scripts/smoke-core.mjs` | 14 checks passed |

`npm run build` emits the wasm as a real asset rather than inlining it:

```
dist/assets/zenvelope_core_bg-Be1-8_sy.wasm  435.32 kB
dist/assets/zenvelope_core-4T6Z0dk2.js         9.97 kB │ gzip:  2.98 kB
dist/assets/index-*.js                       186.06 kB │ gzip: 62.24 kB
```

so the **wasm size served is 435,317 bytes**, fetched as a separate request after the
first paint.

## 2. Wiring the real core into the app

`web/src/core/index.ts` previously looked for `../wasm/core/core.js`, which
`wasm-pack` never produces — so the loader always silently fell back to the MOCK.
Fixed, together with the interface mismatches the real core exposed:

| Mismatch | Fix |
| --- | --- |
| Entry filename | `core.js` → `zenvelope_core.js` (the wasm-pack output name) |
| `derive()` / `parse_fragment()` return wasm-bindgen objects whose fields are getters over WASM memory | The loader copies the fields into a plain object and calls `.free()`, so nothing past the loader holds WASM memory |
| `build_fragment(secret, Option<u32>)` and `payment_uri(addr, amt, Option<String>)` reject `null` | The loader omits the argument entirely instead of passing `null`/`""` |
| A present-but-broken build was being swallowed into the MOCK | The MOCK is now used **only** when no glue file exists; a build that fails to load throws |

The MOCK badge is rendered from `core.isMock`, so it disappears on its own once the real
core loads. The e2e suite asserts the badge is absent on every page it visits.

## 3. Browser proof (Playwright chromium, production build via `vite preview`)

```sh
cd web && npm run e2e        # = npm run build && playwright test
```

```
Running 3 tests using 1 worker
  ✓  1 e2e/m1.spec.ts:70:3 › serves the wasm cross-origin isolated (409ms)
  ✓  2 e2e/m1.spec.ts:87:3 › creates an envelope and re-derives it from the link (2.2s)
  ✓  3 e2e/m1.spec.ts:144:3 › derives the documented address for the fixed test vector (396ms)
  3 passed (5.2s)
```

Committed as `web/e2e/m1.spec.ts` + `web/playwright.config.ts`. It is not part of
`npm test` (vitest is restricted to `src/**/*.test.ts`), because it needs a network
round trip to lightwalletd.

### 3a. Cross-origin isolation

`vite preview` serves `/` and the `.wasm` with `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp`, matching `web/public/_headers`. The
`.wasm` response body is > 100 KB, i.e. the real artifact and not a stub.

### 3b. Create: 0.001 ZEC, message "hello"

| | |
| --- | --- |
| Address | `u1ysp438hrqu304l9gwp4ntmtf92ahgnsl8mq72pkvvqwnpawjh454s0hu7ah2kzplc3rrfmwl8u6rp48kqx33afgetkm0nd8vlqut0pys` |
| Prefix | `u1`, 106 chars, bech32m — **not** the MOCK's `u1mock…` |
| ZIP-321 URI | `zcash:u1ysp438…ut0pys?amount=0.0013&message=hello` |
| Amount | 0.001 ZEC envelope + 0.0003 ZEC flat fee = **0.0013 ZEC**, one output |
| Birthday height | **3,490,439** |
| Height source | `https://zjs.zec.rocks/mainnet`, `CompactTxStreamer/GetLatestBlock` over gRPC-web |
| Fragment | `<43 base64url chars>.3490439` |

The test fetches `GetLatestBlock` from `zjs.zec.rocks` itself, before and after the
click, and asserts the birthday in the fragment falls inside that window — so the
height is provably live and not a constant.

Screenshot: `web/docs/m1-real-create.png`. It shows the full link, fragment included, which is safe here and only here: this envelope was never funded and never will be. A funded link's fragment never goes in a tracked file.

### 3c. Open: `/e#<fragment>`

Navigating to `/e#<fragment>` re-derived **the same** `u1ysp438…ut0pys` address from the
fragment alone, and displayed `Birthday height 3490439`.

Screenshot: `web/docs/m1-real-open.png`.

### 3d. Fixed test vector

```
/e#AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA
```

renders

```
u1nxx35rnvjqzuz03fcg4yur2atgm3j2yl4xsl6l93u5nxw8mxw0t5gxqlqfxruppsy7akehfj5h63j7mqx6z6uzvl0n7f3v08kszpwv4f
```

which is exactly the mainnet vector in `crates/core/TEST_VECTORS.md`. The browser, the
Rust unit tests and the Node smoke test all agree byte for byte.

## 4. Oracle check: does a reference client accept the browser's viewing key?

The viewing key is the one the browser derived in §3b, read from the create page's
collapsed **Advanced: viewing key** section. It reveals amounts and memos; it cannot
spend and it cannot open the envelope.

```sh
B=/root/Projects/web3-sweep/tools/zcash-devtool/target/release/zcash-devtool
W=/root/Projects/web3-sweep/tools/wallets/m1-check
rm -rf "$W" && mkdir -p "$W"

$B wallet -w "$W" init-fvk --name m1-check \
    --fvk uview1jpe8k50yendp39xar60p7nttmcw0em2du5m6gc30mjr04lx94zw4m8l66l5n9wp2xhz8x648mwjy9s8r76hpm4nfq2f7kq8lsm6qj3rekhuleglzesl5sfxzqtnuadu3jyzpmdv89ad8vnhy9ye7mph63h7ss9dpeunszxjpaqvyjj7eny740gg6smljw \
    --birthday 3490439 -s zecrocks

$B wallet -w "$W" sync -s zecrocks
$B wallet -w "$W" get-info -s zecrocks
$B wallet -w "$W" balance --json
$B wallet -w "$W" list-tx
$B wallet -w "$W" list-addresses
$B inspect u1ysp438hrqu304l9gwp4ntmtf92ahgnsl8mq72pkvvqwnpawjh454s0hu7ah2kzplc3rrfmwl8u6rp48kqx33afgetkm0nd8vlqut0pys
```

`init-fvk` took the key without complaint — it reads the network from the key's HRP, so
accepting `uview1…` is itself the assertion that this is a well-formed **mainnet** UFVK.

Sync tail (**1.48 s wall**, exit 0, no errors):

```
INFO zcash_devtool::remote: Connecting to zec.rocks:443
INFO ...sync: Sapling tree has 1128 subtrees
INFO ...sync: Orchard tree has 770 subtrees
INFO ...sync: Ironwood tree has 7 subtrees
INFO ...sync: Latest block height is 3490439
INFO ...sync: Refreshing UTXOs for AccountUuid(ce08494b-b509-4c99-a311-53221500f951) from height 0
INFO ...sync: Fetching ChainTip(3490439..3490440)
INFO ...sync: Scanning ChainTip(3490439..3490440)
INFO ...sync: Scan complete for range ChainTip(3490439..3490440); progress is 0/0
```

```
get-info        {"chain_name":"main","chain_tip_height":3490439,"server_uri":"https://zec.rocks:443"}
balance --json  {"chain_tip_height":3490439,"ironwood_spendable":0,"orchard_spendable":0,
                 "sapling_spendable":0,"total":0,"transparent_spendable":0}
list-tx         Transactions:            (empty, as expected — nothing was funded)
```

**The strongest single result**: `list-addresses` on the oracle wallet prints

```
Account AccountUuid(ce08494b-b509-4c99-a311-53221500f951)
     Default Address: u1ysp438hrqu304l9gwp4ntmtf92ahgnsl8mq72pkvvqwnpawjh454s0hu7ah2kzplc3rrfmwl8u6rp48kqx33afgetkm0nd8vlqut0pys
```

— character for character the address the browser displayed. `zcash_client_sqlite` /
`zcash_keys`, linked into a client that has never seen Zenvelope's code, walked from the
browser's UFVK to the browser's address on its own.

And `inspect` confirms the one-receiver invariant on the live address:

```
Zcash address
 - Network: main
 - Kind: Unified Address
 - Receivers:
   - Orchard (u1ysp438hrqu304l9gwp4ntmtf92ahgnsl8mq72pkvvqwnpawjh454s0hu7ah2kzplc3rrfmwl8u6rp48kqx33afgetkm0nd8vlqut0pys)
```

Exactly one receiver, Orchard, no Sapling and no transparent — per
`crates/core/README.md`, so a sender's wallet cannot pay into a pool the open flow
cannot reach.

### What this does and does not prove

Proved: the browser derives real, well-formed mainnet Zcash key material; a reference
light client accepts it, agrees on the address, and syncs to the chain tip against a
production lightwalletd without errors.

Not proved yet: that a payment to that address is detected and can be moved out. That
needs a real funded envelope, which is the next step — see `M1-FUND.md` (private,
gitignored).
