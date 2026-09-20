# Zenvelope build spec

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
- **Link format**: `https://<host>/e#<secret>`. Secret is 32 random bytes,
  base64url, from the browser CSPRNG. Derives a spending key and a unified
  address with an Ironwood-receiving Orchard receiver (typecode 0x03); Orchard
  outputs are invalid after NU6.3. The fragment is never sent to the server by
  browsers.
- **Sender side**: show a single-output ZIP-321 URI and QR for the link's
  address, for the envelope amount plus the flat fee. The fee is taken as a
  second output of the recipient's sweep transaction, not of the sender's
  payment, because multi-output ZIP-321 is not portable across wallets. Works
  with Zodl, Zingo, ZKool2, Vizor and Cake. Optional Noir wallet connect for
  desktop; Noir is single-recipient, so it builds one single-output payment
  per envelope and never a multi-output transaction.
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
- **Telemetry**: none that identifies a link. Count of links created only.

## Milestones
M0 (done) Repo, README with the one-pager, license, arena project draft, first
   builder update posted.
M1 Create a link on mainnet: secret, derived address, ZIP-321 URI, QR, fee in
   the amount. Verify with Zodl on mainnet.
M2 Open a link on mainnet: scan, decrypt, show amount. This proves the viewing
   path and the hidden-amount reveal.
M3 Spend from the link to a pasted Zcash address in the browser, on mainnet.
   In-browser Ironwood proving. End to end. Demo video 1 recorded here.
M4 Drainer-safe copy, trust-boundary screens, in-browser fresh wallet with seed
   export for recipients who have nothing.
M5 Solana receive option via 1Click, with the warning screen and a fresh Solana
   keypair path. Demo video 2 recorded here.
M6 Group envelopes and CSV export.
M7 Submission pack: 3-minute pitch video, 3-minute demo video, GitHub, Colosseum
   form, Earn listings, Ukraine demo day slot.

## Cut order if short on time
M6 first, then M5, then Noir connect. M0 to M4 are the product.

## Dependencies to verify at M1, not later
- Live gRPC-web handshake to https://zjs.zec.rocks/mainnet from a browser.
- WASM prover size and proving time on a mid-range phone.
- 1Click quote for ZEC in, USDC-on-Solana out, minimum amount and fee.

## Judge-facing proof points
- "We never hold funds" shown as a diagram in the pitch, first 20 seconds.
- ZIP-324 linked in the README with the draft date and author list.
- One named user of group envelopes, with a quote, before submission.

## Names and handles
- GitHub: done, https://github.com/IhorMuliar/zenvelope.
- Domain: deferred. No domain is ours. Until that is decided, the app runs on the
  host's own subdomain (Cloudflare Pages or Netlify), which is enough for the
  milestones and the demo.
- npm name and @zenvelope on X: deferred, not on any milestone's critical path.
