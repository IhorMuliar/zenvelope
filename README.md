# Zenvelope

[![CI](https://github.com/IhorMuliar/zenvelope/actions/workflows/ci.yml/badge.svg)](https://github.com/IhorMuliar/zenvelope/actions/workflows/ci.yml)

Shielded ZEC in a link. The person you send it to needs nothing: no app, no wallet, no account.

- **Sender:** enter an amount, an optional message and an optional From name. Pay one QR
  from any Zcash wallet. Share the link in any chat.
- **Recipient:** open the link in any browser. See the amount and the message. Choose where
  the money goes. On a phone, the spend is proved in about 8 s.

Live: <https://zenvelope.netlify.app>. Open source under MIT. Built for the Colosseum
Crypto World's Fair 2026, Zcash track.

<!-- VIDEO: demo, sender and recipient on mainnet -->
<!-- VIDEO: technical walkthrough -->

## Where the money can go

The recipient picks one of four destinations, in this order:

1. **An exchange account.** Paste the ZEC deposit address from Coinbase, Kraken, Binance or
   others. Transparent deposit addresses work, after a screen that says what becomes public.
2. **USDC or SOL on Solana**, through NEAR Intents. A trust-boundary screen lists what becomes
   public and every fee before anything is sent. A failed swap refunds to the envelope's own
   address, so the same link opens again.
3. **A Zcash wallet app.** Paste a unified address from Zodl, Zingo or another wallet.
4. **A wallet made in the page.** 24 BIP-39 words, shown once, saved nowhere. They restore
   in Zodl or Zingo.

The sender can take back any envelope nobody has opened, at `/back`. Group mode makes up to
50 links at once with a CSV export, for payouts.

## How it works

The link is `https://host/e#<secret>[.<birthday height>]`.

- **Secret.** 32 random bytes from the browser CSPRNG, 43 base64url characters, after the
  `#`. Browsers never send the fragment to a server. The page strips it from the address bar
  once read.
- **Address.** The secret is a ZIP-32 seed, account 0. It derives a unified address with a
  single Orchard receiver (typecode `0x03`), which receives Ironwood notes since NU6.3.
- **Funding.** The page shows a single-output ZIP-321 QR for the amount plus the fee. The
  message and From name travel in the encrypted memo. The page watches the chain and then
  hands out the final link with its funding height.
- **Scan.** The recipient's browser reads compact blocks over gRPC-web
  (`zjs.zec.rocks/mainnet`, ChainSafe failover). It trial-decrypts, shows the amount, then
  walks to the tip to check the note is unspent. A spent envelope shows the spending tx.
- **Proving.** The browser witnesses the note, builds a V6 transaction with Ironwood actions
  and proves it in WASM in a Web Worker: 4 threads when the page is cross-origin isolated,
  one otherwise. Then it broadcasts.
- **Solana exit.** The browser asks NEAR Intents (1Click API) for a quote, pays the quoted
  deposit address, and tracks the swap until USDC or SOL arrives.

```
sender's wallet --shielded payment--> link address (derived from the secret after #)
                                            |
                         recipient's browser finds the note and proves the spend
                                            v
                           exchange / Solana / wallet app / page wallet
server: static HTML, JS and WASM. No keys, no float, no custody.
```

## Verified on mainnet

| Date | What | Transaction |
| --- | --- | --- |
| 2026-09-20 | Envelope funded from Zodl, block 3490472 | [`281e9f7b…341d43`](https://mainnet.zcashexplorer.app/transactions/281e9f7bffa5bffc8ee1287cc6e245cc59eee302727ea9d93c7f8e5a99341d43) |
| 2026-09-21 | Browser-proved send-on, block 3491056 | [`ba0f91cf…fa2aad`](https://mainnet.zcashexplorer.app/transactions/ba0f91cfe7ca33dd269b692bf80027df2681a321215e90ab28c2a56260fa2aad) |
| 2026-09-24 | Two tabs, one link: the losing tab refused with error -25 | [M3 §11](web/docs/M3-VERIFICATION.md#11-concurrent-open-verified-2026-09-24) |
| 2026-09-24 | Solana exit: 14.400612 USDC arrived in 8 minutes | [`b7b2a81b…4c6838`](https://mainnet.zcashexplorer.app/transactions/b7b2a81bbbde3b0e17197d581e40f810ef169497431170186eb4382f9d4c6838) |

Timings. iPhone 16e, Brave: 7.9 s from tap to a proved transaction, 4.4 s of it proving (mainnet dry run). A final link shows the amount
in about 0.6 s. Transcripts: [M1](web/docs/M1-VERIFICATION.md), [M2](web/docs/M2-VERIFICATION.md),
[M3](web/docs/M3-VERIFICATION.md), [M4](web/docs/M4-VERIFICATION.md) (phone),
[M5](web/docs/M5-VERIFICATION.md) (Solana), [PERF](web/docs/PERF-2026-09-21.md) (open).

## Security model and limits

- **The link is a bearer instrument, like cash.** Whoever holds it can open it. A forwarded
  link can be spent by someone else. That is why take-back exists. The amount is not in the
  link, so a link alone tells a stranger nothing.
- **The link key is single-use.** It holds one envelope and is emptied on open. No wallet is
  stored. Nothing persists in the browser.
- **Nothing reaches a server.** The site is static: no backend, no analytics, no cookies, no
  server keys, no custody. Strict CSP, COOP/COEP and HSTS are set.
- **No screen asks for a seed phrase or a wallet connection.** There is no wallet-connect code.
- **Solana is not private.** The swap service sees the amount, the Solana address and the
  requesting IP. The page says so before the recipient chooses it.
- **Take-back is a race.** It works only while nobody has opened the envelope. Once the money
  is sent on, it cannot be reversed.
- **NU7.** Mainnet NU7 is set for 2026-11-05 with 25 s blocks. It adds no new transaction
  format. Two block-count constants (scan lookback, anchor walk) assume 75 s blocks and are
  re-derived before activation.
- **Not done yet.** Subresource integrity and reproducible builds; until then a recipient
  trusts the host to serve this repository's code. Funding a group from one transaction.
  Caching the proving key between visits.

The [/how](https://zenvelope.netlify.app/how) page shows how to check a link yourself.

## Fee

A flat 0.0003 ZEC per envelope. The sender pays it inside the single funding output. It goes
to the service address as a second output of the send-on transaction. The recipient pays
nothing. An envelope too small to cover the fees says so before proving.

## How it compares

| | Receiving side needs | Carries money |
| --- | --- | --- |
| Vizor Gift Cards | The Vizor app | Yes |
| Zapp Zpackets | The Zapp app | Yes |
| ZIP-321 request links, [zkSEND](https://zksend.net) | The payer's own wallet | No, they are requests |
| Zenvelope | A browser | Yes |

Vizor and Zapp are good wallet features, and the person receiving installs that app first.
ZIP-321 links and zkSEND ask a payer to settle from their own wallet. A Zenvelope link carries
the money itself, and adds take-back and cash-out to USDC. Earlier work in the same direction:
[ZIP-324](https://zips.z.cash/zip-0324) (2019 draft) and
[zplash](https://github.com/davisonio/zplash) (ZIP-324 on Sapling).

## Build and run

Rust core in `crates/core` (orchard 0.15.5, zcash_client_backend 0.24), built by wasm-pack
twice: single-thread and wasm-bindgen-rayon multi-thread. Front end: Vite, React,
TypeScript, with the core behind a Web Worker RPC. 107 Rust and 489 web unit tests. CI
(`.github/workflows/ci.yml`) runs them with both wasm builds and the browser suite.

```sh
./scripts/build-core.sh && (cd web && npm install && npm run dev)
cargo test -p zenvelope-core && node scripts/smoke-core.mjs
cd web && npm test && npm run e2e   # e2e builds, then runs Playwright
```

More: [PRODUCT](docs/PRODUCT.md), [DECISIONS](docs/DECISIONS.md),
[crates/core/README.md](crates/core/README.md) (core API), [web/docs/](web/docs/) (transcripts).

## License

MIT. See [LICENSE](LICENSE).
