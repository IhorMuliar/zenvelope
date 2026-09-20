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
payment_uri(address, amount_zat, message?) -> string   // single-output ZIP-321
zat_to_zec_string(zat) -> string
zec_string_to_zat(s) -> zat

// M2, implemented by the scanner in crates/core. Scans and decrypts in the
// browser; the only outbound traffic is gRPC-web to lightwalletd_url.
open_envelope(secret_b64url, birthday | undefined, network, lightwalletd_url,
              on_progress(scanned, total)) -> Promise<{
  found, notes: [{ amount_zat, memo, height, txid, pool }], total_zat, tip_height
}>
```

`on_progress` reports `total = 0` until the scanner knows the span, which is
what keeps the progress bar indeterminate. `amount_zat` and `total_zat` are
decimal strings, because u64 does not cross the WASM boundary as a number.
`pool` is `ironwood`, `orchard` or `sapling`.

Fragment format: `<secret>` optionally followed by `.<decimal birthday height>`.

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
tap. The next-step cards ("Where should it go?") are M3 placeholders and are
disabled.

## End-to-end proof

`e2e/m2-open.spec.ts` runs the open flow on the MOCK core, so it needs no
network and no wasm build: sealed screen, progress from `on_progress`, the
amount and the sender's message, the disabled M3 cards, animations off under
reduced motion, the no-fragment error, and that no link or request on the page
carries the secret. Screenshot: [docs/m2-open.png](docs/m2-open.png).

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

M1: create a link. M2: `/e` opens it — sealed envelope, in-browser scan with
progress, the amount, the sender's message and the note details. The scan itself
is `open_envelope` in the core; with no wasm build present the MOCK simulates it
and says so on screen. Spending what was found is M3.
