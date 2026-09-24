# Colosseum submission form: draft answers

Zcash track, Crypto World's Fair. Closes **2026-10-12, 23:59 PT**. Counts are characters of
the exact text, with a paragraph break counted as two; re-check them after any edit.

**Project name:** Zenvelope

**One-liner (86):** Send shielded ZEC as a link. No wallet, no install, no address, no amount in the link.

**Description (474):**

> Zenvelope turns a shielded ZEC payment into a link. The sender picks an amount and a
> private message and pays one QR from any Ironwood-capable Zcash wallet. Whoever opens
> the link needs nothing: no wallet, no install, no address. The secret after the #
> derives a one-time shielded address and its keys, and their browser scans, decrypts
> and proves the spend on Ironwood. The amount is not in the link. Non-custodial: static
> site, no keys, no float. MIT, verified on mainnet.

**Longer description (1,580):**

> Paying someone in ZEC means asking them for an address, which means they install a
> wallet and write down a seed phrase before they have any money. Zenvelope removes that
> step. The sender sets an amount and a message, pays a single-output ZIP-321 QR from
> Zodl, Zingo, ZKool2, Vizor or Cake, and sends a link.
>
> The link is `https://host/e#secret`, 32 random bytes from the browser CSPRNG. Browsers
> never send the fragment to a server, so the secret lives in the tabs holding the link
> and nowhere else. It derives a unified address with an Orchard receiver, which
> receives Ironwood notes, and that address's viewing and spending keys. The recipient's
> browser streams compact blocks over gRPC-web, trial-decrypts the note, reveals the
> amount, then builds and proves a V6 transaction in WASM inside a Web Worker: under 8
> seconds tap to done on an iPhone 16e at three threads, 4.4 s of it proving, in a dry
> run on mainnet; about 28 seconds on a desktop at four.
>
> Because the amount is not in the link, a forwarded link discloses nothing until it is
> opened. Because no backend touches keys, there is nothing for us to freeze, refund or
> lose; if the site disappeared, an unopened envelope would still be spendable from this
> repo.
>
> Destinations: any Zcash address, a fresh in-browser wallet with seed export, or,
> behind a trust-boundary screen, USDC or SOL on Solana through NEAR Intents, a
> third-party rail we do not operate. Group envelopes make up to 50 links at once, with
> a CSV; each link is funded separately. Every milestone is verified on mainnet, with a
> transcript in `web/docs/`.

**Tracks:** Zcash (primary), Solana (the optional exit rail and in-browser keypair),
general awards.

**Problem:** A shielded payment cannot reach a person with no Zcash wallet. Asking for an
address means install, back up a seed, find the receive screen, send a string, all before
any money has moved, and many never finish. Link gifts shipped so far still ask the
recipient for something: Vizor gift links need Vizor installed, zecgift needs a shielded
address.

**Solution:** Put the money at an address the link derives, and the secret where no server
sees it. The recipient opens a page, watches the amount appear and picks a destination; the
spend is proved in their own browser.

**Technical description:** A Rust core (`crates/core`, WASM via wasm-pack) over
`zcash_client_backend` 0.24, `orchard` 0.15.5 and `zcash_primitives` 0.30, with Ironwood
scanning and spending. It scans over gRPC-web against `zjs.zec.rocks/mainnet` (ChainSafe as
failover), checks nullifiers for spent notes, witnesses every note an envelope holds against
the chain's commitment tree, and spends them all in one V6 transaction. It ships twice,
single-thread and `multicore` (wasm-bindgen-rayon, four threads, +2.4% of wasm), both inside
a Web Worker. Front end: React, Vite, TypeScript, static, strict CSP, COOP/COEP, HSTS, no
analytics, no backend. CI runs the Rust tests, both wasm builds, the web tests and a mock
browser suite.

**What is new here:** (1) The recipient needs nothing: no wallet, no install, no address.
(2) The amount is not in the link and stays hidden until opened. (3) Ironwood spends proved
in the browser, on up to four threads in a Web Worker. (4) Non-custodial by construction.
(5) The Solana exit puts the rail's own undisclosed 25 bps fee on screen before anyone
commits. Prior art we build on: ZIP-324 (2019 draft), zplash (ZIP-324 on Sapling with
browser proving), Vizor gift links, zecgift.

**Business plan:** A flat sender fee per link, 0.0003 ZEC, taken as a second output of the
recipient's send-on transaction. Never a percentage, and recipients pay nothing. Volume
comes from group envelopes: payroll, contractor payouts, community distributions, gifting.
No custody, no float, no in-house conversion, no accounts: the design is chosen so that no
entity in the flow is a MiCA crypto-asset service provider or a money transmitter. Next: a
Zcash coinholder retroactive grant.

**Team:** `<NAME>`, `<ROLE>`, `<GITHUB>`, `<X>`. `<NAME2>`, `<ROLE2>`.

**Links:** Repo `https://github.com/IhorMuliar/zenvelope` · Live `https://zenvelope.netlify.app` ·
Pitch `<PITCH_URL>` · Demo video `https://youtu.be/nH9FWXQz8JM` · Week-1 judge video
`https://youtu.be/GxsZ4AixFj0` · First funding
`281e9f7bffa5bffc8ee1287cc6e245cc59eee302727ea9d93c7f8e5a99341d43` · First browser send-on
`ba0f91cfe7ca33dd269b692bf80027df2681a321215e90ab28c2a56260fa2aad` · Solana exit
`b7b2a81bbbde3b0e17197d581e40f810ef169497431170186eb4382f9d4c6838`

**Known limitations:**

1. No subresource integrity and no reproducible builds yet. Until they exist, a recipient
   trusts the host to serve the code this repository contains.
2. A browser served without cross-origin isolation, or one whose wasm-threads probe fails,
   falls back to the single-threaded prover: same transaction, roughly 47 s instead of 23 s
   on a desktop. WebKit is not the dividing line (the 2026-09-21 iPhone run was Brave on iOS,
   isolated, and proved on three threads); the headers are.
3. The proving key is rebuilt on every visit; caching it between visits is not built.
4. Group envelopes are funded one link at a time from the sender's wallet; funding a batch
   from one transaction is not built.
5. Sending on is bound by the public lightwalletd gateway, and that varies widely: the
   witness walk took about 3 s on the iPhone run of 2026-09-21 and about 22 s on a desktop
   through the same gateway. Opening a final link is fast: since 2026-09-24 one carrying its
   funding height reveals in about 0.6 s and finishes the spent check in about 1.5 s on a
   desktop, against 31 s for a link that scans from creation. Your own gateway removes the
   variance.
6. The Solana exit is poor value at small amounts: about 16% spread into USDC at the
   0.00132 ZEC floor against about 1% into SOL. The screen says so, and the shielded way out
   stays one tap away.
