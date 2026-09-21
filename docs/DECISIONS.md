# Decision log

One entry per decision. Newest section first. Each entry: what we decided, why, and
the evidence it rests on. If something here contradicts another doc, this file wins.

## 2026-09-21

### D18 The witness walk is capped at 24 blocks (was 120 earlier the same day)

**Decision.** The sweep's anchor is `min(tip, newest note height + ANCHOR_WALK_CAP)` with
`ANCHOR_WALK_CAP = 24` blocks, about half an hour of mainnet at 75 s per block. Any finalized tree state's root is a consensus-valid anchor, so the walk exists only to keep the anchor off the exact funding block; 24 blocks costs about 2 s of Sinsemilla hashing on a desktop and under 1 s on a recent phone, where 120 cost about 10 s (PERF §10). It was 120 for a few hours on 2026-09-21.
The old rule walked all the way to the tip whenever the envelope was within ~1,500 blocks
of it, and fell back to the note's own block beyond that. Also: in the threaded wasm
package, the open scan's trial decryption now runs on the rayon pool M4 built for proving
(PERF-2026-09-21.md §7, first bullet).

**Why.** The witness stage replays one block per block of distance, and the envelope ages.
A 777-block-old envelope replayed 777 blocks and cost 28-32 s; a month-old one would
replay about 35,000. The cap makes that cost constant instead of a function of how long
the link sat unopened. The recipient who opens a link minutes after it was funded — the
normal case — is unaffected, because the tip is then the smaller of the two terms.

**This is a privacy/latency trade-off, not a correctness one.** Zebra accepts a spend
against the root of **any** finalized Ironwood tree state, so an anchor 120 blocks past
the note is as consensus-valid as the tip. The M3 spike verified a same-block anchor
against mainnet, which is the extreme case of the same rule. What the cap costs is
anonymity-set freshness: an observer reading an old envelope's anchor learns the
transaction was built against a tree state no later than `note + 120`, a narrower window
than "somewhere near the tip". Anyone reading the anchor already knows the funding
transaction, and that is the same information the rejected same-block anchor would have
leaked in full.

Every correctness check is untouched. The replayed Ironwood root is still compared against
the server's `GetTreeState` at every note block, the anchor root is still the server's own,
and `WitnessScan::finish` still refuses a sweep whose replay disagrees with the chain.

**Evidence.** Measured 2026-09-21 on the fee envelope from the private M3-DEST.md, dry run,
nothing broadcast: [../web/docs/PERF-2026-09-21.md](../web/docs/PERF-2026-09-21.md) §8.

### D17 Phone performance measured

**Decision.** Publish the phone figure as measured rather than estimated, and stop
saying phone proving time is unknown. On an **iPhone 16e**, Brave on iOS (WebKit),
cross-origin isolated and proving on **3 threads**, against the live site on build
`6fa7f9f`: open and scan **5.5 s**, the proving key warming **11.8 s** in the background
while the envelope is read, **0.0 s** of actually waiting for it, `witness` **3.2 s**,
`proving` **4.4 s**, **7.9 s** from "Send it on" to done — under 8 seconds, on the same
9,166-byte transaction the desktop builds.

**Why it matters.** The open flow was budgeted on desktop numbers, and the phone is
where a recipient with nothing actually opens a link. At 4.4 s of proving and under 8
seconds tap to done, in-browser proving needs no escape hatch on a current phone;
delegated proving through ZIP-374 (D8) stays optional, for older devices, rather than
planned work.

**The desktop reference on the same build**, 8-vCPU DigitalOcean droplet, Chrome, 4
threads, through the same live site and gateway: open and scan 12.0 s, keys 16.7 s,
`witness` 10.1 s, `proving` 17.9 s, total 28.2 s. That machine is a shared cloud vCPU
and its scan and witness rows are mostly gateway round trips, so read the gap as the
host and the network rather than as a verdict on desktop browsers, and take the phone's
figures as the phone's.

**Evidence.** Measured 2026-09-21 at 17:45 UTC on the owner's device against
<https://zenvelope.netlify.app>, gateway `zjs.zec.rocks`, headers verified, on a real
mainnet envelope. The sweep took the dry-run path: **nothing was broadcast**. One
device, one run each, not a benchmark. Transcript:
[../web/docs/M4-VERIFICATION.md](../web/docs/M4-VERIFICATION.md), "Phone measurement".

### D16 Host: Netlify, by direct upload

**Decision.** Ship on **Netlify**, deployed by `netlify deploy --prod --dir=web/dist`
from a build made on the droplet — no CI build on the host, no Git integration. Live at
<https://zenvelope.netlify.app>. Cloudflare Pages is the better free tier on the numbers
and stays the documented migration target; `public/_headers` is the file both hosts read,
so moving is a re-upload and nothing else. This closes what D9 left open.

**Why Netlify, given that.** It is the account that exists. The droplet's browser profile
is signed into Netlify and not into Cloudflare, and the account rule on this project
forbids creating accounts or signing in. A live demo on the second-best tier beats a
better tier nobody can deploy to.

**Why Cloudflare Pages is better on the numbers**, and what we accept by not using it:

1. **Bandwidth.** Cloudflare Pages: *"On both free and paid plans, requests to static
   assets are free and unlimited."* Netlify's free plan is a **hard 300 credits per
   month**, not purchasable on Free, and bandwidth costs **20 credits per GB** — a
   ceiling of **15 GB/month**. Our cold load is ~1.2 MB over the wire (the 2.2 MB WASM
   gzips to 1.04 MB), so that is roughly **12,000 cold loads a month**. Ample for
   judging; not ample for a front page.
2. **Cost of deploying.** Netlify charges **15 credits per production deploy** — twenty
   deploys consume the entire monthly allotment before a single visitor arrives. Deploy
   Previews and branch deploys are free, so iterate there and promote rarely.
   Cloudflare's equivalent limit is 500 *builds* per month and direct upload uses none.
3. **What happens at zero.** When the credits run out, **every project on the team is
   paused** and serves a `Site not available` page until the next cycle. That is the one
   failure mode that would cost us the demo, so **watch Usage & billing** during judging.
   The account currently also holds a 400-credit promotional balance.

**What both hosts do equally well.** Headers were never the deciding factor. Netlify
reads `_headers` from the publish directory *and* `netlify.toml`, which
`src/lib/headers.test.ts` keeps byte-equivalent; Cloudflare Pages reads `_headers` only.
Verified live on 2026-09-21 with `curl -sI`: COOP `same-origin`, COEP `require-corp`,
CORP `same-origin`, the full CSP, HSTS (Netlify adds `preload` of its own),
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` — on `/`, on `/e`, and on both
`.wasm` files, which are served as `application/wasm`. `/e` returns 200 through the
`_redirects` SPA rule. The page reports `crossOriginIsolated === true` and
`proving: 4 threads`.

**Commercial use.** Neither free tier forbids it. Cloudflare's Service-Specific Terms
restrict *the CDN* from serving "video or a disproportionate percentage of pictures,
audio files, or other large files" without a paid service, and name the Developer
Platform — which is what Pages is — as the product for exactly that; the clause does not
reach Pages. Netlify's constraint is the credit ceiling, not the purpose. Neither asks
for a credit card to start.

**One surprise worth writing down.** On Netlify's credit-based plans a new project is
**private by default** and answers `401` behind a team-login redirect until someone
presses **Make public** in the project overview. A deploy that reports "Deploy is live!"
can still be invisible to the world. Check with `curl -sI` after every first deploy.

**Custom domain.** Both allow one on the free plan, so the domain deferred in D9 can be
attached later without changing hosts.

**Evidence.** Fetched 2026-09-21:
- <https://developers.cloudflare.com/pages/functions/pricing/> — static asset requests
  free and unlimited on both plans.
- <https://developers.cloudflare.com/pages/platform/limits/> — 25 MiB per asset, 20,000
  files, 500 builds/month, 100 header rules at 2,000 characters.
- <https://www.netlify.com/pricing/> and
  <https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/>
  — 300 credits/month hard limit, 20 credits/GB, 15 credits per production deploy, all
  projects paused at zero.
- <https://www.cloudflare.com/service-specific-terms-application-services/> — the CDN
  large-file clause and the Developer Platform carve-out.
- Live verification of the deployed site, 2026-09-21.

### D15 The link secret is stripped from the URL once it has been read

**Decision.** `/e` reads `location.hash` once at mount, hands the fragment to the core,
and then rewrites the history entry with
`history.replaceState(null, "", location.pathname + location.search)`. Everything after
that — the scan, every retry, the sweep — works from the in-memory ref. **A reload
therefore loses the secret**, by design: the page then shows the ordinary "this link has
no envelope in it" screen, and every open screen carries the line *"Keep the original
link: this page forgets it when reloaded."*

**Why.** A Zenvelope link is a bearer capability: whoever holds it can spend the
envelope. Left in the fragment it stayed in the address bar for the whole open → scan →
prove flow — minutes — and therefore in the history entry, in whatever the browser syncs
between devices, in a screenshot of the tab, and in anything the recipient taps "share
page" on. None of that is needed: the flow reads the fragment exactly once. Meanwhile
the screen said "The secret in this link stayed in your browser", which was true and
also incomplete.

Three options were weighed.

1. **Leave it.** Reload works, and the secret sits in the URL bar for minutes. The
   disclosure is silent and the recipient has no way to know it happened. Rejected.
2. **Strip it and keep a copy in `sessionStorage`,** so a reload still works. That trades
   the URL bar for a storage API, which is worse: `sessionStorage` survives the tab's
   navigation, is readable by any script on the origin, and the product's whole claim is
   that it writes the secret nowhere. Rejected, and asserted against by every e2e run.
3. **Strip it and lose the reload.** Chosen. The recipient already has the link — it
   arrived in a message they still have, which is exactly where a bearer capability
   belongs — so the cost is one tap back to that message, and it is stated on screen
   rather than discovered.

`replaceState` rather than `pushState`: a push would leave the previous entry, the one
with the secret in it, one Back press away.

**Evidence.** `web/src/lib/fragmentStrip.test.ts` (the rule, including that nothing is
pushed and that a browser refusing `replaceState` does not break the open) and
`web/e2e/m2-open.spec.ts` (`location.hash` empty after the open, the reload screen, and
Back/Forward carrying nothing), plus the same assertion on the real core in
`m3-real.spec.ts` and `m5-real.spec.ts`. From the 2026-09-21 security review, finding
H1.

**What is not solved.** The link is still in the messaging app it arrived in, in that
app's own history and backups, and possibly in a preview fetch that app made. That is
outside the page entirely; the fix here is about the window between the recipient
opening the link and the money moving.

### D14 The Solana swap's refund address is the envelope itself

**Decision.** `refundTo` on every 1Click quote defaults to **the envelope's own unified
address** — the same `u1…` the link derives and the sweep is spending from. The recipient
is asked for nothing. A field on the same screen lets them override it with a Zcash
address of their own, and leaving it empty is the normal case, not a blocked one.

**Why.** A swap that fails sends the ZEC back to `refundTo`, so that address decides who
can recover the money. Three candidates were considered.

1. **A transparent address derived for the envelope.** The core exposes no transparent
   key path, so this needs a new core export — and the open page could not spend what
   landed there, because it finds and spends Ironwood notes at the envelope's shielded
   address. A refund would be visible on-chain *and* stranded. Rejected.
2. **Demand a `t1` from the recipient, empty = blocked.** The whole product premise is a
   recipient who has no wallet and no address; demanding one at the last step to guard
   against a failure that usually does not happen is the wrong trade. Rejected.
3. **The envelope's own unified address.** Costs nothing: `derive()` already returns it
   and `/e` already has it on screen. A refund lands back in the envelope, and **the same
   link opens it again** — the recipient needs nothing they did not already have. Chosen.

The refund is therefore also the only part of the exit that stays shielded, which is the
right default for a screen whose whole subject is leaving the shielded pool.

**Evidence.** Probed live on 2026-09-21 against `POST /v0/quote`: `refundTo` set to the
M1 test vector's unified address `u1nxx35rn…` is **accepted** (HTTP 201, a priced quote
comes back), a `t1` is accepted, and a Sapling `zs1` and a nonsense string are both
refused with `{"message":"refundTo is not valid"}`. The rail's `refundFee` is 32,000
zatoshi, shown on the screen. Transcript in
[web/docs/M5-VERIFICATION.md](../web/docs/M5-VERIFICATION.md).

**What is not proved.** We never broadcast, so no refund has actually been paid to a
unified address; the evidence is that the rail's own validator accepts one. The override
field exists for exactly that residual risk, and the copy explains it.

### D12 Block explorer for the done screen

**Decision.** Link finished sweeps to `https://mainnet.zcashexplorer.app/transactions/<txid>`,
recorded as `EXPLORER_TX` in `web/src/config.ts`. Testnet uses the same host's
`testnet.` subdomain.

**Why.** The recipient needs one link that shows the transaction really happened, and the
candidates are not equally alive.

**Evidence.** Probed 2026-09-21 with the known mainnet txid
`281e9f7bffa5bffc8ee1287cc6e245cc59eee302727ea9d93c7f8e5a99341d43`:
`mainnet.zcashexplorer.app` **200** and the page renders the transaction (a bogus txid
gives 404), `3xpl.com` 200, `zcashblockexplorer.com` did not resolve, `blockchair.com`
401. First working candidate wins.

### D13 No fee is taken until there is a real fee address

**Decision.** `FEE_ADDRESS` in `web/src/config.ts` is the empty string, and the open flow
passes `fee_zat "0"`, builds no fee output and shows no fee line. `FLAT_FEE_ZAT` stays as
it is, and filling the address in is the only change needed to start charging.

**Why.** The constant used to hold a made-up unified address. A sweep is the recipient's
money, and a second output to an address that does not decode fails the whole
transaction, so a placeholder that looks like an address is worse than no address at all.
D5 is unchanged: the fee still rides on the sweep, it is just switched off until it has
somewhere to go.

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
