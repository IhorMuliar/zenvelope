# Zenvelope build spec

**Status, 2026-09-24:** this is the original build plan, kept for the record. M0 to M5 are done and
verified on mainnet, with transcripts in [web/docs/](../web/docs/). Still not done: subresource integrity
and reproducible builds, batch funding of group envelopes, and proving-key caching between visits.

Superseded items are recorded in DECISIONS.md.

No calendar. Milestones in dependency order. Each is shippable on its own.
Cut from the bottom if time runs out.

## Architecture
- **Web app**, static, open source, MIT. Any host. No backend that touches keys.
- **Zcash in the browser**: WASM light client, a fork of
  ZcashCommunityGrants/WebZjs (zcash_client_backend 0.24, orchard 0.15.5), talking
  gRPC-web to https://zjs.zec.rocks/mainnet, failover
  https://zcash-mainnet.chainsafe.dev. Plain zec.rocks:443 is a native gRPC
  endpoint for CLI tools only: no gRPC-web bridge, no CORS, unusable from a
  browser. Hosted with COOP/COEP for WASM threads.
- **Link format**: `https://<host>/e#<secret>[.<birthday height>]`. Secret is 32 random bytes,
  base64url, from the browser CSPRNG. Derives a spending key and a unified
  address with an Ironwood-receiving Orchard receiver (typecode 0x03); Orchard
  outputs are invalid after NU6.3. The fragment is never sent to the server by
  browsers.
- **Sender side**: show a single-output ZIP-321 URI and QR for the link's
  address, for the envelope amount plus the flat fee. The fee is taken as a
  second output of the recipient's sweep transaction, not of the sender's
  payment, because multi-output ZIP-321 is not portable across wallets. Works
  with Zodl, Zingo, ZKool2, Vizor and Cake. There is no wallet connect: the
  planned Noir connect was cut.
- **Recipient side**: browser scans for notes to the link's address using the
  viewing key, reveals the amount with an "open the envelope" animation, then
  spends to the destination the recipient picks.
- **Solana option**: recipient chooses "receive as USDC or SOL". Browser calls
  the NEAR Intents 1Click quote API directly (CORS is open), gets a transparent
  ZEC deposit address, and the browser spends the note to it. Destination is a
  Solana address the recipient pastes or a fresh keypair generated in-browser
  with import instructions. Trust warning shown before the quote.
- **Group envelopes**: client generates N secrets and N links, and the sender
  makes N single-output payments, one per link, each for that envelope's
  amount plus the flat fee. No multi-output URI: it is not portable across
  wallets (D5). Sender downloads a CSV of links.
- **Telemetry**: none. No analytics of any kind.

## Milestones
M0 (done) Repo, README with the one-pager, license, arena project draft, first
   builder update posted.
M1 (done 2026-09-20) Create a link on mainnet: secret, derived address, ZIP-321
   URI, QR, fee in the amount. Verified with Zodl on mainnet: the first envelope
   was funded from a shielded balance by scanning the QR, and the Ironwood note
   was confirmed independently by zcash-devtool from the browser-generated
   viewing key (tx 281e9f7b…341d43, block 3490472). Transcript in
   web/docs/M1-VERIFICATION.md.
M2 (done 2026-09-21) Open a link on mainnet: scan, decrypt, show amount. The
   viewing path and the hidden-amount reveal are proved: the browser derived the
   viewing key from the link fragment alone, streamed 64 compact blocks from the
   link's birthday to the chain tip over gRPC-web in 2.0 s, trial-decrypted the
   Ironwood note and showed 0.0013 ZEC, matching the zcash-devtool oracle field
   for field (tx 281e9f7b…341d43, block 3490472). It also proved that a ZIP-321
   `message=` never reaches the chain (the M1 note arrived with Memo::Empty), so
   the sender's text now rides in the ZIP-321 `memo=` parameter and is encrypted
   on-chain. Transcript in web/docs/M2-VERIFICATION.md.
M3 (done 2026-09-21) Spend from the link to a pasted Zcash address in the
   browser, on mainnet. In-browser Ironwood proving. End to end. Done: the sweep
   was proved in the browser and broadcast, through the product's own screens.
   The /e page opened the real M1 envelope, warmed the Ironwood proving key in
   the background, took a pasted unified address, showed the fee breakdown
   (0.0013 in, 0.0001 network fee, 0.0003 Zenvelope fee, 0.0009 out), witnessed
   the note against the chain's own Ironwood tree, proved a two-action V6
   transaction on four threads and sent it: 40.3 s from the tap to "Sent.",
   mined in block 3,491,056 as
   ba0f91cfe7ca33dd269b692bf80027df2681a321215e90ab28c2a56260fa2aad. Three
   independent view-only zcash-devtool wallets confirm it: the envelope's note
   is spent (balance 0), the destination received 90,000 zat and the fee
   envelope 30,000 zat, both Ironwood. Transcript in
   web/docs/M3-VERIFICATION.md, §9 for the broadcast. Demo video 1 recorded here.
M4 (done 2026-09-21) Drainer-safe copy, trust-boundary screens, in-browser
   fresh wallet with seed export for recipients who have nothing, plus the proving
   work those screens need to be worth reading. Done: the core runs in a Web Worker
   and proves on a 4-thread rayon pool from a second wasm package, so a desktop dry
   sweep is 23 s tap to done against M3's 49 s and the progress screen keeps
   painting throughout; the sender-side copy is one audited module with the drainer
   lure word banned by tests; the trust boundary is its own screen behind a required
   tick; and group envelopes with a CSV shipped here. Measured on an iPhone 16e (Brave
   on iOS, 3 threads): under 8 s tap to done, 4.4 s of it proving. Transcript in
   web/docs/M4-VERIFICATION.md.
M5 (done 2026-09-24, live swap verified) Solana receive
   option via 1Click, with the warning screen and a fresh Solana keypair path.
   Built: the third card on "Where should it go?" leads to the trust-boundary
   screen, and its required tick is the way past it; then USDC or SOL, then a Solana
   address pasted or an Ed25519 keypair generated here in crypto.subtle and
   exported in the 64-byte form Phantom and Solflare import; then a live dry quote
   that puts the whole cost of leaving on screen: what arrives, both dollar
   figures, the spread, the ~8 minutes and the rail's own 25 bps house fee that the
   rail does not display. "Get deposit address" takes a real quote and the ordinary
   sweep pays the transparent t1 it returns, spending every note the envelope holds
   in one transaction at the transparent ZIP-317 fee for that spend count; the rail
   is quoted on the summed envelope less those fees. refundTo is the envelope's own
   unified address, so a failed swap lands back in the envelope and the same link
   opens it again (DECISIONS D14). Live swap verified 2026-09-24: a 0.0103 ZEC
   envelope on the live site paid the rail, and 14.400612 USDC arrived about 8
   minutes after the tap (tx b7b2a81bbbde3b0e17197d581e40f810ef169497431170186eb4382f9d4c6838).
   Transcript in web/docs/M5-VERIFICATION.md. Demo video 2 recorded here.
M6 (done, shipped with M4) Group envelopes and CSV export: up to 50 links, each funded
   separately by the sender's wallet. Batch funding from one transaction is not built.
M7 (submission, outside the product) Submission pack: 3-minute pitch video,
   3-minute demo video, GitHub, Colosseum form, Earn listings, Ukraine demo day slot.

## Cut order if short on time
Historical. Noir connect was cut; M0 to M6 shipped.

## Dependencies to verify at M1, not later
- Live gRPC-web handshake to https://zjs.zec.rocks/mainnet from a browser.
  **Done at M1**: the browser reads the chain tip over gRPC-web and uses it as the
  link's birthday height.
- WASM prover size and proving time on a mid-range phone. Half answered at M3:
  the M3 core carries the Orchard/Ironwood halo2 circuit and is 2,231,657 bytes
  (1,030 KB gzip), up from 788,781 bytes (390 KB gzip) at M2 and 435,317 bytes
  (253 KB gzip) at M1. On a desktop in Playwright chromium the proving key costs
  about 27 s and the proof about 42 s, single-threaded. **Answered at M4 for the
  desktop**: the core moved into a Web Worker, so the main thread is free and the
  progress screen repaints throughout, and a second wasm package built with
  `orchard/multicore` and wasm-bindgen-rayon proves on 4 threads: key 16 s, proof
  15 s, 23 s from the tap to the done screen, at a cost of 53,545 bytes of wasm
  (+2.4%). The pool is capped at 4 because the curve flattens there. On a phone
  (iPhone 16e, Brave on iOS, 3 threads, 2026-09-21): under 8 s tap to done, 4.4 s of
  it proving. See web/docs/M4-VERIFICATION.md.
- 1Click quote for ZEC in, USDC-on-Solana out, minimum amount and fee. **Answered
  at M5**: https://1click.chaindefuser.com/v0, no API key, CORS `*` with
  `content-type` as the only allowed request header. The minimum is not published:
  it comes back as an HTTP 400 "Amount is too low for bridge, try at least N", which
  is the only place the app reads it from (132,000 zatoshi = 0.00132 ZEC on
  2026-09-21). A real quote reserves a transparent t1 deposit address for three
  days, with no memo and no tag. Every quote carries the rail's own 25 bps appFee,
  and the destination withdrawal fee dominates at small amounts: about 16% spread
  into USDC at the floor against about 1% into SOL. See web/docs/M5-VERIFICATION.md.

## Judge-facing proof points
- "We never hold funds" shown as a diagram in the pitch, first 20 seconds.
- ZIP-324 linked in the README with the draft date.
- One named user of group envelopes, with a quote, before submission.

## Names and handles
- GitHub: done, https://github.com/IhorMuliar/zenvelope.
- Domain: deferred. No domain is ours. Until that is decided, the app runs on the
  host's own subdomain (Cloudflare Pages or Netlify), which is enough for the
  milestones and the demo.
- npm name and @zenvelope on X: deferred, not on any milestone's critical path.
