# Zenvelope web app

Static Vite + React + TypeScript app. No backend, no analytics, and the only
outbound request is a gRPC-web call to lightwalletd for the current chain height.

## Run

```sh
cd web
npm install
npm run dev      # http://localhost:5173
npm test         # vitest unit tests
npm run build    # type check + production build into web/dist
npm run preview  # serve the build with the same COOP/COEP headers
npm run e2e      # build, then the Playwright proof in e2e/ against the real core
```

Node 20+ is required (Node 22 is what this was built on).

## Routes

| Route  | What it does                                                      |
| ------ | ----------------------------------------------------------------- |
| `/`    | Landing and the create-an-envelope form                            |
| `/e`   | Open the envelope. Reads the secret from `location.hash`           |
| `/how` | The "we never hold funds" flow in five steps                       |

Add `?net=test` to `/` to reveal the network toggle. Mainnet is the default and
the only network shown otherwise (DECISIONS D4).

## The WASM core

`src/core/index.ts` dynamically imports `src/wasm/core/zenvelope_core.js` and
calls its `default()` init. That directory is produced by `wasm-pack` from
`crates/core`, is gitignored, and is rebuilt with:

```sh
../scripts/build-core.sh     # from the repo root: ./scripts/build-core.sh
```

**If the build is absent, the app falls back to a MOCK core**
(`src/core/mock.ts`) so the UI stays testable. The MOCK is loud about it: a
badge on every screen, and every address it produces contains the string `mock`
and is not spendable. The badge is driven by `core.isMock`, so it disappears the
moment a real build is present. A build that is present but *fails to load* is a
bug, not a reason to fall back — the loader throws instead.

The wasm-bindgen glue returns `derive()` and `parse_fragment()` as objects
holding WASM memory. The loader copies their fields into plain objects and calls
`.free()`, so nothing past `src/core/index.ts` has to think about it.

The interface both implementations satisfy is in `src/core/types.ts`:

```ts
derive(secret_b64url, network) -> { address, ufvk, diversifier_index }
generate_secret() -> string            // 32 bytes base64url, 43 chars
parse_fragment(frag) -> { secret, birthday? }
build_fragment(secret, birthday?) -> string
payment_uri(address, amount_zat, memo?) -> string      // single-output ZIP-321,
                                                      // memo= is base64url UTF-8
zat_to_zec_string(zat) -> string
zec_string_to_zat(s) -> zat

// M2, implemented by the scanner in crates/core. Scans and decrypts in the
// browser; the only outbound traffic is gRPC-web to lightwalletd_url.
open_envelope(secret_b64url, birthday | undefined, network, lightwalletd_url,
              on_progress?(scanned, total)) -> Promise<{
  found, notes: [{ amount_zat, memo, height, txid, pool, action_index }],
  total_zat, tip_height, birthday, birthday_defaulted, scanned_blocks
}>

// M3, the spend. Proving runs in this browser; the only outbound traffic is
// gRPC-web to lightwalletd_url.
warm_proving_key() -> Promise<number>            // milliseconds it took
classify_address(addr, network) -> {
  kind: "unified_orchard" | "unified_no_orchard" | "sapling" | "transparent" | "invalid",
  reason: string | null
}
new_wallet(network, birthday) -> { mnemonic, address, ufvk, birthday }
sweep_envelope(secret_b64url, network, lightwalletd_url,
               note: { txid, height, action_index },
               destination, fee_address, fee_zat, memo | null, broadcast,
               on_stage(stage, detail)) -> Promise<{
  txid, raw_tx_hex: string | null, amount_to_destination_zat, fee_zat,
  network_fee_zat, anchor_height, broadcast,
  error_code: number | null, error_message: string | null
}>
```

`stage` is `witness`, `keys`, `proving`, `broadcast` or `done`, in that order.
`fee_zat` is a decimal string, and `"0"` with an empty `fee_address` means no fee
output at all. A failure that spent nothing comes back as a resolved result with
`error_code` set rather than as a rejection; the page treats a rejection the same
way. `warm_proving_key` is safe to call twice and the open flow calls it in the
background the moment the envelope is found, because proving is single-threaded
in this milestone: about 35 s for the key and 52 s for the proof on a desktop,
and up to four times that on a slow phone.

`on_progress` is optional and reports `total = 0` until the scanner knows the
span, which is what keeps the progress bar indeterminate. `birthday` is the
height the scan actually started at, `birthday_defaulted` says whether the link
carried one, and `scanned_blocks` is `tip_height - birthday + 1`. `amount_zat` and `total_zat` are
decimal strings, because u64 does not cross the WASM boundary as a number.
`pool` is `ironwood`, `orchard` or `sapling`.

Fragment format: `<secret>` optionally followed by `.<decimal birthday height>`.

## The sender's message

It goes into the ZIP-321 **`memo=`** parameter, base64url of its UTF-8 bytes with
no padding, so the sending wallet writes it into the note and it is encrypted
on-chain. `/e` decrypts it and shows it as "Their message". The field is 512
bytes, and the create form counts bytes rather than characters (`memoByteLength`
in `src/lib/format.ts`), because one emoji costs four.

M1 used the ZIP-321 `message=` parameter instead, and M2's scan of that envelope
proved it never reaches the chain: the oracle reports `Memo::Empty`. A `message`
is a label the sending wallet keeps for its own history, so nothing in the app
offers one any more.

## Opening an envelope

`/e#<fragment>` is five states, driven by the reducer in `src/lib/openFlow.ts`
so the flow can be tested without a DOM:

```
reading -> sealed -> scanning -> opened | empty | failed
                       ^                     |
                       +------ retry --------+
```

The sealed screen shows an envelope, one button and no amount or message: the
core loads in the background while the recipient reads. Opening calls
`open_envelope` against the primary lightwalletd and, on a thrown error, retries
once against the failover host (DECISIONS D3) before offering a retry. The
unwrap is CSS only and `prefers-reduced-motion: reduce` switches it off, landing
on the same end state. `src/lib/format.ts` turns zatoshi into the displayed ZEC
string: trailing zeros trimmed, always one decimal ("1.0 ZEC"), thousands
separators on the whole part.

No price API: showing a fiat number would mean telling a price server that an
envelope was just opened, so M2 shows ZEC only and puts the question behind a
tap.

## Sending it on

"Where should it go?" is `src/components/SendOn.tsx`, driven by the reducer in
`src/lib/sweepFlow.ts`:

```
choose -> review -> sending -> sent
   ^        |          |
   +--------+          +-----> failed --(send again)--> sending
```

The proving key starts building the moment the envelope is found, before the
recipient has chosen anything, so the wait overlaps with reading: the card says
"Preparing keys… ~40 s" and then "Keys ready".

**Destinations.** A pasted address is classified on every keystroke by
`classify_address`, and `src/lib/destination.ts` turns that into what the
recipient is told:

| Kind | Result |
| --- | --- |
| unified with an Orchard receiver | yes, stays shielded |
| transparent `t1` | yes, warned that this leaves the shielded pool and is visible on-chain |
| Sapling-only `zs1` | no: "this address type is not supported yet, paste a unified address starting with u1" |
| unified without an Orchard receiver | no: it cannot take an Ironwood note |

The second option generates a wallet here with `new_wallet` at the current chain
tip, shows the 24 words, the address and the birthday height, and will not go on
until "I wrote these down" is ticked. **The mnemonic is never stored**: it lives
in one piece of React state and on the screen, and it is gone with the tab. The
Solana rail is disabled and says so.

**Money.** `sweepAmounts` in `src/lib/amount.ts` does every sum in bigint
zatoshi: envelope − miner fee − flat fee = what the recipient receives. The
miner fee is 0.0001 ZEC (ZIP-317, two actions) or 0.00015 ZEC when the
destination is transparent. The flat Zenvelope fee comes from `FLAT_FEE_ZAT` and
`FEE_ADDRESS` in `src/config.ts`; `FEE_ADDRESS` is **empty** until a real one
exists, so the sweep is asked for `fee_zat "0"`, builds no fee output, and the
review screen shows no fee line.

**While it runs.** The four stages are a checklist with an elapsed clock. A
screen wake lock is requested for the duration and every failure of it is
ignored. A `beforeunload` warning is added only while proving and broadcasting,
because only those throw away work that cannot be redone. Nothing is persisted
at any point, so there is no state to come back to and none to leak.

**When it ends.** "Sent." with the txid, a copy button, a link to the explorer in
`EXPLORER_TX` (`mainnet.zcashexplorer.app`, picked by probing the candidates
against the known mainnet txid `281e9f7b…341d43` on 2026-09-21: it and 3xpl
answered 200, zcashblockexplorer.com did not resolve and blockchair answered
401), and "The envelope is now empty." A failure shows the core's message, a
retry button, and the line that the funds are still in the envelope.

One sweep spends one note. The scan can find several, and then the largest is
sent on and the screen says the rest stay put. Unlike the scan, the sweep does
not fail over to the second lightwalletd host: retrying a broadcast against a
different node is not a safe thing to do automatically, so a failure is handed to
the recipient with a retry button instead.

## End-to-end proof

`e2e/m2-open.spec.ts` is two groups. The MOCK group runs the open flow on the
MOCK core, so it needs no network and no wasm build: sealed screen, progress from
`on_progress`, the amount and the sender's message, the disabled M3 cards,
animations off under reduced motion, the no-fragment error, and that no link or
request on the page carries the secret. It is skipped when a wasm build is
present, because then the page is on the real core and its made-up secret would
scan mainnet for nothing. Screenshot: [docs/m2-open.png](docs/m2-open.png).

Its second group opens the **real funded mainnet envelope** through the same
page, on the real core served by `vite preview` with the production COOP/COEP
headers. It needs the link secret, which is never committed, so it reads
`ZENV_M1_FRAGMENT` at run time and skips without it:

```sh
cd web && ZENV_M1_FRAGMENT='<secret>.<birthday>' npm run e2e
```

It asserts the opened screen shows 0.0013 ZEC, pool "shielded (Ironwood)", block
3,490,472 and the txid the oracle sees, with no MOCK badge anywhere, and prints
the scan wall time and block count. Screenshot:
[docs/m2-open-real.png](docs/m2-open-real.png), recorded run in
[docs/M2-VERIFICATION.md](docs/M2-VERIFICATION.md).

`e2e/m3-open.spec.ts` is the M3 proof, on the MOCK only: the warm-up that turns
into "Keys ready", a pasted `zs1` refused and the fixed unified address from
`crates/core/TEST_VECTORS.md` accepted, the transparent warning and its higher
fee, the new-wallet path with its 24 words and its checkbox gate, the review
arithmetic, the four stages in order with a clock, and the done screen with the
txid, the copy button and the explorer link. It also asserts that nothing was
written to localStorage or sessionStorage, that no link or request carries the
secret, and that the word "claim" is nowhere on any screen. Screenshots:
[docs/m3-choose.png](docs/m3-choose.png),
[docs/m3-progress.png](docs/m3-progress.png),
[docs/m3-done.png](docs/m3-done.png). The MOCK spends 3 s warming and 1 s per
stage, so the timing under test is real even though the chain is not. Like the
M2 MOCK group it skips itself when a wasm build is present: a real sweep is
somebody's money and does not belong in an unattended test run.

`e2e/m2-core.spec.ts` drives the built wasm directly on a bare isolated page and
checks the note against the zcash-devtool oracle. Same environment variable, same
skip.

`e2e/m1.spec.ts` drives the production build and asserts the app is on the real
core: a mainnet `u1…` address that is not the MOCK's, the single-output ZIP-321
URI, a birthday height cross-checked against a live `GetLatestBlock` call,
re-derivation of the same address from `/e#<fragment>`, and the fixed vector
from `crates/core/TEST_VECTORS.md`. It needs the network and a wasm build, and
it skips itself when `src/wasm/core` is absent. The recorded run is in
[docs/M1-VERIFICATION.md](docs/M1-VERIFICATION.md).

## Handling of the secret

The secret is generated by `crypto.getRandomValues` in the browser, held in a
React state value on `/` and in a ref on `/e`, and rendered into the link. It is
never written to localStorage or sessionStorage, never put in a query string,
never logged, and never sent anywhere but the core. Browsers do not send the URL
fragment to servers, so `/e#…` discloses nothing to the host, and no link the
open page renders carries the fragment onward.

## Chain height

`src/lib/grpcweb.ts` is a hand-rolled gRPC-web unary client: no library, about a
hundred lines. It POSTs the five-byte empty-message frame to
`…/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock`, then parses the
response frames and the `BlockID { uint64 height = 1; bytes hash = 2 }`
protobuf with a small varint reader. Primary host `zjs.zec.rocks`, failover
`chainsafe.dev` (DECISIONS D3); if both fail, the link is created without a
birthday.

## Headers

`public/_headers` is the Cloudflare Pages / Netlify header file: COOP
`same-origin` and COEP `require-corp` so WASM threads are available,
`X-Content-Type-Options: nosniff`, and a strict CSP whose `connect-src` allows
only the two lightwalletd hosts. `vite.config.ts` sets the same COOP/COEP on the
dev and preview servers. The open flow needs nothing added to that policy: the
envelope is inline SVG, there is no external asset, no inline style and no
request beyond the lightwalletd hosts already listed. `index.html` also carries
`<meta name="referrer" content="no-referrer">`, alongside the `Referrer-Policy`
header.

## Status

M1: create a link. **M2 is done**: `/e` opens it — sealed envelope, in-browser
scan with progress, the amount, the sender's message and the note details, proved
on mainnet on 2026-09-21 against the funded M1 envelope
([docs/M2-VERIFICATION.md](docs/M2-VERIFICATION.md)). The scan is `open_envelope`
in the core; with no wasm build present the MOCK simulates it and says so on
screen.

**M3's web UI is in place**: the whole send-on flow — destination matrix, new
in-browser wallet, review, the four proving stages and the done screen — runs
end to end against the MOCK, and the core interface it codes against
(`warm_proving_key`, `classify_address`, `new_wallet`, `sweep_envelope`, and
`action_index` on a found note) is in `src/core/types.ts` and enforced by the
loader's `REQUIRED` list. The mainnet proof waits on that core landing in
`crates/`.
