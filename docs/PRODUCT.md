# Zenvelope

**Send shielded ZEC as a link. The recipient needs no wallet, no install and no address.**
Live at <https://zenvelope.netlify.app>. MIT. Verified on mainnet (see the README).

## What it is
A sender funds a link from a Zcash wallet. The recipient opens it in any browser and moves
the money where they choose. No wallet, no install, no address exchange, and the amount is
not in the link. Prior art: ZIP-324 (2019 draft), zplash (2026, ZIP-324 on Sapling with
browser proving), Vizor gift links (2026, recipient installs Vizor) and zecgift (2026,
recipient supplies a shielded address). What Zenvelope adds: the recipient needs nothing,
no amount in the link, Ironwood.

## How it works
The link carries a 32-byte secret in the URL fragment, which browsers never send to a
server. The secret derives a unified address with a single Orchard receiver, which receives
Ironwood notes. The sender pays a single-output ZIP-321 QR from Zodl, Zingo, ZKool2, Vizor or
Cake; the message travels in the encrypted memo. On open, the recipient's browser scans the
chain, reveals the amount, checks for spends, then proves and broadcasts the send-on
transaction in WASM. The site is static: no backend, no analytics, no keys, no custody.

## Where the money can go
1. Any Zcash unified address the recipient pastes.
2. A fresh wallet generated in the browser (24 BIP-39 words, restores in Noir and Zodl).
3. USDC or SOL on Solana through NEAR Intents, a third-party rail, behind a trust-boundary
   screen that lists what becomes public and every fee. A failed swap refunds to the
   envelope, so the same link opens again.

## Group envelopes
Up to 50 links at once, fixed amount per link, with a CSV export. The sender's wallet funds
each link separately. Meant for payroll, contractor payouts, community distributions and
gifting.

## Fee
A flat 0.0003 ZEC per envelope, not a percentage. The sender pays it inside the single
funding output; it reaches the service address as a second output of the send-on
transaction. Recipients pay nothing.

## What we are not
Not a custodian, not an exchange, not a bridge. No float, no in-house conversion, no account,
no KYC, no server-side keys. The design is chosen so that no entity in the flow is a MiCA
crypto-asset service provider or a money transmitter.

## Not done yet
Subresource integrity and reproducible builds; funding a group from one transaction;
caching the proving key between visits.

## Who it is for
- ZEC holders paying someone who has no Zcash wallet.
- Zcash community organizers distributing to many recipients.
- Gifting inside the Zcash community.

## Copy rules
The usual drainer lure word is banned on every screen (`web/src/copy/en.test.ts`). Use
"open", "receive", "unwrap". Never ask for a seed phrase or a wallet connection.
