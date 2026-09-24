# Zenvelope

[![CI](https://github.com/IhorMuliar/zenvelope/actions/workflows/ci.yml/badge.svg)](https://github.com/IhorMuliar/zenvelope/actions/workflows/ci.yml)

**Send shielded ZEC as a link. The recipient needs no wallet, no install and no address.**
Live: <https://zenvelope.netlify.app>. Built for the Colosseum Crypto World's Fair 2026, Zcash track.

## What it is

A sender funds a link from a Zcash wallet. The recipient opens it in any browser and moves
the money where they choose: no wallet, no install, no address exchange, and the amount is
not in the link. It is non-custodial: the secret sits in the URL fragment, which browsers
never send to a server, and the site is static with no backend and no analytics.

## How it works

The link is `https://host/e#<secret>[.<birthday height>]`. The secret is 32 random bytes from
the browser CSPRNG (43 base64url characters), used as a ZIP-32 seed, account 0. It derives a
unified address with a single Orchard receiver, which receives Ironwood notes after NU6.3.

1. **Create.** The page shows a single-output ZIP-321 QR for the amount plus a flat fee,
   payable from Zodl, Zingo, ZKool2, Vizor or Cake. The message rides in the encrypted memo.
   The page watches for the payment and hands out the final link with its funding height.
2. **Open.** The browser scans compact blocks over gRPC-web (`zjs.zec.rocks/mainnet`, ChainSafe
   failover), trial-decrypts, reveals the amount and checks for spends: about 0.6 s to reveal
   and 1.5 s to finish on a desktop. An opened envelope says so and shows the spending
   transaction. The sender can reopen their own link to take back money nobody has taken.
3. **Send on.** The browser witnesses the notes, builds a V6 transaction with Ironwood actions,
   proves it in WASM in a Web Worker (4 threads when cross-origin isolated, else one) and
   broadcasts it. iPhone 16e, Brave on iOS, 3 threads: under 8 s tap to done, 4.4 s proving.

```
sender's wallet --shielded payment--> link address (derived from the URL fragment)
                                            |
                          viewing key finds the note, spending key moves it
                                            v
                                recipient's browser (holds the secret)
                                            v
                              destination the recipient chooses
our server: static HTML, JS and WASM. No keys, no float, no custody.
```

## Where the money can go

- Any Zcash unified address the recipient pastes.
- A fresh wallet generated in the browser: 24 BIP-39 words that restore in Noir and Zodl.
- USDC or SOL on Solana through NEAR Intents, a third-party rail. A trust-boundary screen
  lists what becomes public and every fee, including the rail's house fee. A failed swap
  refunds to the envelope's own address, so the same link opens again. At small amounts this
  exit is poor value, and the screen says so.

## Group envelopes

Create up to 50 links at once and export a CSV
(`index,link,address,envelope_zec,send_zec,memo,payment_uri`). The sender's wallet funds each
link separately; funding a batch from one transaction is not built.

## Fee

A flat 0.0003 ZEC per envelope, not a percentage. The sender pays it inside the single
funding output, and it goes to the service address as a second output of the send-on
transaction. Recipients pay nothing. An envelope too small to cover the fees says so before
proving.

## Safety

No screen asks for a seed phrase or a wallet connection, and there is no wallet-connect code.
The open page is where funds move, and nowhere else. The usual drainer lure word is banned on
every screen, enforced by `web/src/copy/en.test.ts` and the Playwright suites. Strict CSP,
COOP/COEP and HSTS are set, and the secret is stripped from the URL once it is read. The
[/how](https://zenvelope.netlify.app/how) page explains how to verify a link yourself: read
the host, confirm the fragment is never sent, read the open code, and check the transaction
on `mainnet.zcashexplorer.app`.

## Verified on mainnet

| Date | What | Transaction | Transcript |
| --- | --- | --- | --- |
| 2026-09-20 | First envelope funded from Zodl, block 3490472 | `281e9f7b…341d43` | [M1](web/docs/M1-VERIFICATION.md) |
| 2026-09-21 | First browser send-on, block 3491056 | `ba0f91cf…fa2aad` | [M3 §9](web/docs/M3-VERIFICATION.md#9-broadcast-verified) |
| 2026-09-24 | Concurrent open: the losing tab rejected with error -25 | | [M3 §11](web/docs/M3-VERIFICATION.md#11-concurrent-open-verified-2026-09-24) |
| 2026-09-24 | Solana exit: 14.400612 USDC arrived about 8 minutes after the tap | `b7b2a81b…4c6838` | [M5 §7](web/docs/M5-VERIFICATION.md#7-live-swap-verified) |

Timings: [M4](web/docs/M4-VERIFICATION.md) (phone), [PERF](web/docs/PERF-2026-09-21.md) (open).

## What is not done

- Subresource integrity and reproducible builds. Until they exist, a recipient trusts the
  host to serve this repository's code.
- Funding a group of envelopes from one transaction.
- Caching the proving key between visits.

## Prior art

- [ZIP-324](https://zips.z.cash/zip-0324): URI-encapsulated payments, draft from 2019.
- [zplash](https://github.com/davisonio/zplash) by davisonio, 2026-03-20: ZIP-324 on Sapling with browser proving.
- Vizor gift links, 2026-09-14: the recipient installs Vizor.
- zecgift, January 2026: browser-based, the recipient supplies a shielded address.

What Zenvelope adds: the recipient needs nothing, the amount is not in the link, and it runs on Ironwood.

## Stack and building

Rust core in `crates/core` (orchard 0.15.5, zcash_client_backend 0.24, zcash_primitives 0.30),
built by wasm-pack twice: single-thread and wasm-bindgen-rayon multi-thread. Front end: Vite,
React, TypeScript, the core behind a Web Worker RPC. CI (`.github/workflows/ci.yml`) runs the
Rust tests, both wasm builds, the web tests and the mock browser suite.

```sh
./scripts/build-core.sh && (cd web && npm install && npm run dev)
cargo test -p zenvelope-core && node scripts/smoke-core.mjs
cd web && npm test && npm run e2e   # e2e builds, then runs Playwright
```

## Docs

[PRODUCT](docs/PRODUCT.md) (one-pager), [DECISIONS](docs/DECISIONS.md) (decision log),
[BUILD_SPEC](docs/BUILD_SPEC.md) (original build plan), [crates/core/README.md](crates/core/README.md)
(core API contract), [web/docs/](web/docs/) (verification transcripts).

## License

MIT. See [LICENSE](LICENSE).
