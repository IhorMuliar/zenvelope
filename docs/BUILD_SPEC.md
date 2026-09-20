# Zenvelope build spec

No calendar. Milestones in dependency order. Each is shippable on its own.
Cut from the bottom if time runs out.

## Architecture
- **Web app**, static, open source, MIT. Any host. No backend that touches keys.
- **Zcash in the browser**: WASM light client (zcash_client_backend compiled to
  WASM, as zplash proved works) talking gRPC-web to a public lightwalletd
  (zec.rocks:443, fallback zec-node.cakewallet.com:443).
- **Link format**: `https://<host>/e#<secret>`. Secret is 32 random bytes,
  base64url. Derives a Sapling/Orchard spending key and unified address. The
  fragment is never sent to the server by browsers.
- **Sender side**: show a ZIP-321 URI and QR for the link's address with the
  amount, plus a second output for the flat fee to our address. Works with
  Zodl, Ywallet, Zingo. Optional Noir wallet connect for desktop.
- **Recipient side**: browser scans for notes to the link's address using the
  viewing key, reveals the amount with an "open the envelope" animation, then
  spends to the destination the recipient picks.
- **Solana option**: recipient chooses "receive as USDC or SOL". Browser calls
  the NEAR Intents 1Click quote API directly (CORS is open), gets a transparent
  ZEC deposit address, and the browser spends the note to it. Destination is a
  Solana address the recipient pastes or a fresh keypair generated in-browser
  with import instructions. Trust warning shown before the quote.
- **Group envelopes**: client generates N secrets, N links, one ZIP-321 URI
  with N outputs (or N sequential payments if the wallet lacks multi-output).
  Sender downloads a CSV of links.
- **Telemetry**: none that identifies a link. Count of links created only.

## Milestones
M0 Repo, README with the one-pager, license, arena project draft, first builder
   update posted.
M1 Create a link on testnet: secret, derived address, ZIP-321 URI, QR, fee
   output. Verify with Zodl testnet.
M2 Open a link on testnet: scan, decrypt, show amount. This proves the viewing
   path and the hidden-amount reveal.
M3 Spend from the link to a pasted Zcash address in the browser. WASM proving.
   This completes ZIP-324 end to end. Demo video 1 recorded here.
M4 Mainnet switch, drainer-safe copy, trust-boundary screens, in-browser fresh
   wallet with seed export for recipients who have nothing.
M5 Solana receive option via 1Click, with the warning screen and a fresh Solana
   keypair path. Demo video 2 recorded here.
M6 Group envelopes and CSV export.
M7 Submission pack: 3-minute pitch video, 3-minute demo video, GitHub, Colosseum
   form, Earn listings, Ukraine demo day slot.

## Cut order if short on time
M6 first, then M5, then Noir connect. M0 to M4 are the product.

## Dependencies to verify at M1, not later
- Live gRPC-web handshake to zec.rocks:443 from a browser.
- WASM prover size and proving time on a mid-range phone.
- 1Click quote for ZEC in, USDC-on-Solana out, minimum amount and fee.

## Judge-facing proof points
- "We never hold funds" shown as a diagram in the pitch, first 20 seconds.
- ZIP-324 linked in the README with the draft date and author list.
- One named user of group envelopes, with a quote, before submission.

## Names and handles to secure before M0
zenvelope on GitHub and npm, zenvelope.xyz or .app, @zenvelope on X if the
dead squat can be reclaimed, otherwise @zenvelope_xyz.
