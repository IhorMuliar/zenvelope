# Colosseum submission form — draft answers

Zcash track, Crypto World's Fair. Closes **2026-10-12, 23:59 PT**. Re-check the counts
after any edit.

**Project name:** Zenvelope

**One-liner (86):** Send shielded ZEC as a link. No wallet, no install, no address, no
amount in the link.

**Description (484):**

> Zenvelope turns a shielded ZEC payment into a link. The sender picks an amount and a
> private message and pays one QR from any Zcash wallet. Whoever opens the link needs
> nothing — no wallet, no install, no address — because the secret after the # derives a
> one-time shielded address and its keys, and their browser scans, decrypts and proves
> the spend on Ironwood. The amount is not in the link. Non-custodial by construction:
> static site, no keys, no float. MIT, mainnet from day one.

**Longer description (1,438):**

> Paying someone in ZEC means asking them for an address, which means they install a
> wallet and write down a seed phrase before they have any money. Zenvelope removes that
> step. The sender sets an amount and a message, pays a single-output ZIP-321 QR from
> Zodl, Zingo, ZKool2, Vizor or Cake, and sends a link.
>
> The link is `https://host/e#secret`, 32 random bytes from the browser CSPRNG. Browsers
> never send the fragment to a server, so the secret lives only in the tabs holding the
> link. It derives a unified address with an Ironwood receiver and that address's viewing
> and spending keys. The recipient's browser streams compact blocks over gRPC-web,
> trial-decrypts the note, reveals the amount, then builds and proves a V6 transaction in
> WASM — a ~750 KB prover: 13.5 seconds tap to done on an iPhone 16e at two threads,
> about 24 seconds on a desktop at four.
>
> Because the amount is not in the link, a forwarded link discloses nothing until it is
> opened. Because no backend touches keys, there is nothing for us to freeze, refund or
> lose; if the site disappeared, an unopened envelope would still be spendable from this
> repo.
>
> Destinations: any Zcash address, a fresh in-browser wallet with seed export, or —
> behind a trust-boundary screen — USDC or SOL on Solana through a third-party rail we do
> not operate. Group envelopes make up to 50 links at once, with a CSV. Every milestone
> is verified on mainnet, with a transcript in `web/docs/`.

**Tracks:** Zcash (primary), Solana (the optional exit rail and in-browser keypair),
general awards.

**Problem:** A shielded payment cannot reach a person with no Zcash wallet. Asking for an
address means install, back up a seed, find the receive screen, send a string — before
any money has moved, and most never finish. Existing link gifts still need a wallet
installed or an address the recipient lacks.

**Solution:** Put the money at an address only the link derives, and the secret where no
server sees it. The recipient opens a page, watches the amount appear and picks a
destination; the spend is proved in their own browser.

**Technical description:** A Rust core (`crates/core`, WASM via wasm-pack) over
`zcash_client_backend` 0.24 and `orchard` 0.15.5, forked from ZcashCommunityGrants/WebZjs
and extended with Ironwood scanning and spending. It scans over gRPC-web against
`zjs.zec.rocks/mainnet` (ChainSafe as failover), witnesses every note an envelope holds
against the chain's commitment tree, and spends them all in one transaction. It ships
twice — default, and `multicore` (wasm-bindgen-rayon) on four threads for +2.4% of wasm —
both inside a Web Worker. Front end: React, Vite, static, COOP/COEP, no analytics, no
backend.

**What is novel:** (1) The recipient needs nothing — no wallet, no install, no address —
unlike the link gifts shipped so far. (2) The amount is not in the link and is hidden
until opened. (3) Ironwood spends proved in a browser at ~750 KB on
four threads. (4) Non-custodial by construction. (5) The Solana exit prices the rail's
own undisclosed 25 bps fee before anyone commits.

**Business plan:** A flat sender fee per link, 0.0003 ZEC today, taken as a second output
of the recipient's sweep — never a percentage, and recipients pay nothing. Volume comes
from group envelopes: payroll, contractor payouts, community distributions, gifting. No
custody, no float, no in-house conversion, no accounts, which keeps us outside MiCA's
service-provider definitions and outside money transmission. Next: a Zcash coinholder
retroactive grant.

**Team:** `<NAME>` — `<ROLE>`, `<GITHUB>`, `<X>`. `<NAME2>` — `<ROLE2>`.

**Links:** Repo `https://github.com/IhorMuliar/zenvelope` · Demo `https://zenvelope.netlify.app` · Pitch
`<PITCH_URL>` · Demo video `<DEMO_VIDEO_URL>` · First funding
`281e9f7bffa5bffc8ee1287cc6e245cc59eee302727ea9d93c7f8e5a99341d43` · First sweep
`ba0f91cfe7ca33dd269b692bf80027df2681a321215e90ab28c2a56260fa2aad` · Week-1 judge video
`https://youtu.be/GxsZ4AixFj0`

**Known limitations:**

1. A browser served without cross-origin isolation, or one whose wasm-threads probe
   fails, falls back to the single-threaded prover: same transaction, roughly 47 s
   instead of 23 s on a desktop. WebKit is not the dividing line — the 2026-09-21 iPhone
   run was Brave on iOS, isolated, and proved on two threads — the headers are.
2. Opening an envelope is bound by the public lightwalletd gateway, and that varies
   widely: the scan and the witness walk took about 8 s on the iPhone run of 2026-09-21
   and about 28 s on a desktop through the same gateway an hour earlier. Proving is the
   predictable part; the network is not. Pointing the app at your own gateway removes it.
3. The Solana exit is poor value at small amounts — about 16% spread into USDC at the
   0.00132 ZEC floor against about 1% into SOL. The screen says so, and the shielded way
   out stays one tap away.
