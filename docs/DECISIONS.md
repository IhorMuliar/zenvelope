# Decision log

One entry per decision. Newest section first. Each entry: what we decided, why, and
the evidence it rests on. If something here contradicts another doc, this file wins.

## 2026-09-20

### D1 Headline: not "first production ZIP-324"

**Decision.** Drop "first production implementation of ZIP-324" everywhere. Position
Zenvelope as taking ZIP-324's 2019 idea to the open web and to the Ironwood pool: the
recipient needs no wallet, no install and no address, and the amount is not in the link
and stays hidden until the envelope is opened. Credit prior art generously in the README.

**Why.** The statement was false and would have been caught by a Zcash-track judge.

**Evidence.** zplash shipped a full ZIP-324 Sapling implementation with browser WASM
proving on 2026-03-20, live at <https://zplash.vercel.app>:
<https://github.com/davisonio/zplash>. Vizor shipped bearer gift links on 2026-09-14 in
v0.0.55 (Vizor releases page; announcement:
<https://x.com/vizorwallet/status/2099491332792430710>), with the recipient installing
Vizor to open one.

### D2 Pool: Ironwood

**Decision.** Use the Ironwood pool, reached through a unified address carrying the
Orchard receiver typecode `0x03`. Sapling is kept only as a written fallback plan, not
as the build target.

**Why.** NU6.3 "Ironwood" activated on mainnet around 2026-07-28; ZIP 258 forbids new
value entering the Orchard pool, so Orchard outputs are invalid after activation, while
typecode `0x03` in a unified address now receives Ironwood notes at the same circuit
size. Sapling would also cost us 51.5 MB of proving parameters, and download.z.cash does
not serve them cross-origin, so a browser cannot fetch them.

**Evidence.** <https://zips.z.cash/zip-0258>

### D3 Light client endpoint

**Decision.** Talk gRPC-web to `https://zjs.zec.rocks/mainnet` (and `/testnet`), with the
ChainSafe proxies as failover: <https://zcash-mainnet.chainsafe.dev>. Self-host an Envoy
`grpc_web` filter later if we outgrow the public gateways.

**Why.** `zjs.zec.rocks` is zec.rocks' own gRPC-web gateway; probed live today, it
answers and streams. Plain `zec.rocks:443` speaks gRPC but has no gRPC-web bridge and no
CORS headers, so a browser cannot use it directly.

**Evidence.** Live probe, 2026-09-20; see D11 for latency. <https://zec.rocks>

### D4 Network: mainnet from M1

**Decision.** Build and demo on mainnet starting at M1. No testnet milestone.

**Why.** NU7 activates on testnet on 2026-10-06, inside the hackathon window, which
would break a testnet build mid-build. Mainnet NU7 is 2026-11-05, after submissions
close, so mainnet is the stable target for the whole project. NU7 introduces no new
transaction format, so nothing in our flow changes at activation.

**Evidence.** <https://forum.zcashcommunity.com/t/nu7-timeline/57655>

### D5 Fee mechanism: single-output ZIP-321

**Decision.** The sender's ZIP-321 URI has exactly one output, for
*envelope amount + flat fee*. The fee is collected as a second output in the sweep
transaction when the recipient opens the envelope. Recipients pay nothing extra.

**Why.** Multi-output ZIP-321 is not portable. Zodl on iOS rejects it (it fails closed),
and so do Zodl on Android, Zingo, Edge and Cake. Only ZKool2 supports it. A one-output
URI works everywhere, and the sweep transaction is ours to construct, so the fee can ride
along there at no compatibility cost.

**Evidence.** Wallet-by-wallet check, 2026-09-20. <https://zips.z.cash/zip-0321>

### D6 Sender wallets

**Decision.** Support and test against Zodl, Zingo, ZKool2, Vizor and Cake. Drop Ywallet
and Nighthawk from all docs.

**Why.** Those five ship Ironwood support. Ywallet and Nighthawk dropped Zcash. Zodl is
the wallet formerly known as Zashi (renamed Feb/Mar 2026), which is why older notes use
the other name.

**Evidence.** Wallet survey, 2026-09-20.

### D7 Codebase: fork ZcashCommunityGrants/WebZjs

**Decision.** Fork <https://github.com/ZcashCommunityGrants/WebZjs> (HEAD 2026-09-11) and
add Ironwood scanning and spending, which it does not have.

**Why.** That fork is current: up-to-date crates, a working seed to spending key to PCZT
flow, gRPC-web transport and COOP/COEP setup, so the only gap is Ironwood. ChainSafe's
original WebZjs is stale: last commit 2026-04-16, the npm package is gone, and its crates
predate NU6.3.

**Evidence.** Repo inspection, 2026-09-20.

### D8 Proving: in the browser

**Decision.** Prove Ironwood spends in the browser. The baseline builds the proving key
on page load. Planned upgrade: fork `halo2_proofs` 0.3.5 to add proving-key
serialization (porting the implementation from privacy-ethereum/halo2) and ship a ~6 MB
key blob with a pinned hash, which removes keygen from the critical path.

**Why.** Keygen costs about 22 s of WASM on 4 threads (measured today), which is the
single worst number in the open flow. Serializing the key turns that into a download we
can cache.

**Evidence.** Local measurement, 2026-09-20; see D11.

**Optional later.** Delegated proving through PCZT
(<https://zips.z.cash/zip-0374>), offered as a disclosed "fast open" for phones. The
prover sees the transaction but cannot spend, and it stays opt-in and labelled.

### D9 Hosting

**Decision.** Host on Cloudflare Pages or Netlify. Domain deferred: no domain is
registered to us and none is planned before submission; ship on the host's own
subdomain.

**Why.** Both let us set COOP and COEP response headers, which cross-origin isolation and
therefore WASM threads require. GitHub Pages cannot set custom headers at all. A
custom domain buys nothing the milestones need, and `zenvelope.xyz` is in any case
registered by a third party.

**Evidence.** Host header-configuration docs, 2026-09-20.

### D10 Solana exit

**Decision.** Keep NEAR Intents 1Click as the Solana exit rail, unchanged. Disclose every
cost to the recipient before they commit, including the rail's own house fee.

**Why.** The economics only work above a floor, and the recipient must see the floor and
the spread before choosing this path. Minimum is 0.00132 ZEC (about a $2 floor, read
straight out of the API error), the spread is 40-60 bps plus a 0.00032 ZEC refund fee,
and there is a silent 25 bps house fee that we will surface ourselves.

**Evidence.** 1Click quote API probe, 2026-09-20. <https://docs.near-intents.org>

### D11 Measured dependency numbers

**Decision.** Record today's measurements as the baseline that M1-M3 budgets are built
on, and re-measure before submission.

**Why.** Every performance decision above (D3, D8, D2) rests on these, and they will
drift.

**Evidence.** Measured 2026-09-20:
- `zjs.zec.rocks`: about 0.2 s per call.
- Ironwood/Orchard 1-action proof in WASM: 20.6 s at 4 threads on desktop, 28-31 s at
  4-6x CPU throttle.
- Prover WASM bundle: about 750 KB brotli.
- Sapling proving parameters: 51.5 MB, incompressible.
