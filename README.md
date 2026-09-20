# Zenvelope

**Send shielded money as a link. No wallet, no address, no amount on screen.**

Built for the [Colosseum Crypto World's Fair 2026](https://colosseum.com), Zcash track.

## What it is

Zenvelope takes the idea behind [ZIP-324](https://zips.z.cash/zip-0324), Zcash's 2019
draft for URI-encapsulated payments, to the open web and to the Ironwood pool. A sender
funds a link from a shielded ZEC balance. The recipient opens that link in any browser:
no wallet, no install, no address exchange. The amount is not in the link and stays
hidden until the envelope is opened.

### Prior art

We are not first to send ZEC by link, and we say so plainly. What we are trying to make
first-class is the recipient having nothing at all: no app, no address, no amount leaked
in the URL.

- **[ZIP-324](https://zips.z.cash/zip-0324)** — *URI-Encapsulated Payments*, Draft,
  created 2019-07-17, never finalized. The original design we build on.
- **[zplash](https://github.com/davisonio/zplash)** by davisonio — shipped 2026-03-20, a
  full ZIP-324 implementation on Sapling with proving in the browser via WASM, live at
  [zplash.vercel.app](https://zplash.vercel.app). It proved the browser side is real.
- **Vizor gift links** — shipped 2026-09-14 in Vizor v0.0.55
  ([announcement](https://x.com/vizorwallet/status/2099491332792430710)), bearer links
  for gifting ZEC. The recipient installs Vizor to open one.

## How it works, in one paragraph

The link contains a secret in the URL fragment. That secret derives a shielded Zcash
address and its viewing and spending keys. The sender's wallet pays to that address.
When the recipient opens the link, their browser uses the viewing key to find the note
and reveal the amount, then uses the spending key to move the funds where they choose.
The secret never leaves the browser and never reaches our server. We cannot see,
freeze, or take the money. We are a website that hosts the open-source code, nothing
more.

## We never hold funds

```
  sender's wallet
        |
        |  shielded payment (ZEC)
        v
  link address on-chain  <-- derived from the secret in the URL fragment
        |
        |  viewing key finds the note, spending key moves it
        v
  recipient's browser    <-- the secret lives here, and only here
        |
        v
  destination the recipient chooses
  (their Zcash address, a fresh in-browser wallet, or a third-party exit rail)


  our server:  static HTML, JS and WASM.  No keys, no float, no custody.
               The URL fragment is never sent to it by any browser.
```

There is no account, no balance we hold, and no step where the money passes through
us. If this site disappeared tomorrow, an unopened envelope would still be spendable
by anyone holding the link, using the open-source code from this repo.

## Where the money can go on open

1. **Shielded ZEC** to any Zcash address the recipient pastes, or to a fresh
   in-browser Zcash wallet we generate for them. This is the product.
2. **USDC or SOL on Solana**, optional, routed through a third-party swap rail the
   recipient chooses. It is shown behind an explicit trust-boundary warning: this
   leaves the shielded pool, and here is what you give up. The rail is not ours, and
   we never hold funds on either side.

## Group envelopes

One sender, N recipients, fixed amounts per link. For payroll, contractor payouts,
community distributions, and holiday gifting. Fixed split only. No random split, and
never a payment by the recipient to open an envelope.

## Fee

The sender funds a single output of *envelope amount + flat fee*. The fee is paid to
Zenvelope when the recipient opens the envelope, as a second output in the sweep
transaction. One output keeps the ZIP-321 URI compatible with every sender wallet.
It is a flat service fee, not a percentage. Recipients pay nothing.

## What we are not

Not a custodian, not an exchange, not a bridge. No float, no in-house conversion, no
account, no KYC, no server-side keys. The design is chosen so that no entity in the
flow is a MiCA crypto-asset service provider or a money transmitter.

## Status

Milestones, in dependency order. Full spec in [docs/BUILD_SPEC.md](docs/BUILD_SPEC.md),
product one-pager in [docs/PRODUCT.md](docs/PRODUCT.md), decision log in
[docs/DECISIONS.md](docs/DECISIONS.md).

- [x] **M0** Repo, README one-pager, license, arena project draft, first builder update posted.
- [ ] **M1** *(in progress)* Create a link on mainnet: secret, derived address, ZIP-321 URI, QR, fee in the amount.
- [ ] **M2** Open a link on mainnet: scan, decrypt, show the amount.
- [ ] **M3** Spend from the link to a pasted Zcash address in the browser, on mainnet, with in-browser Ironwood proving. End to end.
- [ ] **M4** Drainer-safe copy, trust-boundary screens, fresh in-browser wallet with seed export.
- [ ] **M5** Solana receive option via a third-party rail, with the warning screen and a fresh keypair path.
- [ ] **M6** Group envelopes and CSV export.
- [ ] **M7** Submission pack: 3-minute pitch video, 3-minute demo video, GitHub, Colosseum form, Earn listings, Ukraine demo day slot.

## ZIP-324

<https://zips.z.cash/zip-0324> — *URI-Encapsulated Payments*. Status: **Draft**.
Created **2019-07-17**, never finalized.

- **Owners:** Jack Grigg, Daira-Emma Hopwood, Kris Nuttycombe
- **Original authors:** Ian Miers, Eran Tromer, Jack Grigg, Kevin Gorham, Daira-Emma Hopwood
- **Credits:** Sean Bowe, Deirdre Connolly, Linda Naeun Lee, George Tankersley, Henry de Valence

The ZIP specifies sending a Zcash payment over any unmodified messaging channel: the
URI encapsulates the key material of an ephemeral address that already holds the funds,
and the recipient moves them to their own wallet with an ordinary on-chain transaction.

### How Zenvelope differs from the ZIP

- **Link shape.** Ours is `https://host/e#secret`. The ZIP preferred a non-resolving
  host so no server could serve code that sees the secret. We accept the served-JS risk
  and mitigate it: static hosting, subresource integrity, reproducible builds, open
  source, no analytics.
- **No amount in the link.** The ZIP left human-readable amounts as an open question.
  Our answer is to leave them out entirely, so a shared link discloses nothing.
- **Secret.** 32 random bytes, base64url, not a Bech32-encoded key.
- **Pool.** Ironwood, reached through a unified address, not Sapling.
- **Generation.** The browser CSPRNG generates the secret; it is not derived through
  ZIP-32. The sender therefore cannot recover a lost link.
- **Recipient.** A web page, not a whitelisted wallet application.
- **Note discovery.** Chain scanning with the viewing key, not the ZIP's deterministic
  note-commitment lookup.

## Building

`crates/core` is the key-derivation core: a link secret in, an Orchard-only unified
address and a ZIP-321 payment URI out. It compiles to WASM for the browser.

```sh
./scripts/build-core.sh   # wasm-pack build into web/src/wasm/core
cargo test -p zenvelope-core && node scripts/smoke-core.mjs
```

Spec and JS API: [crates/core/README.md](crates/core/README.md). Fixed vectors:
[crates/core/TEST_VECTORS.md](crates/core/TEST_VECTORS.md).

The rest of the stack, still to come:

- Static web app, open source, MIT, hostable anywhere. No backend that touches keys.
- Zcash in the browser: a WASM light client based on the
  [ZcashCommunityGrants/WebZjs](https://github.com/ZcashCommunityGrants/WebZjs) fork,
  on `zcash_client_backend` 0.24 and `orchard` 0.15.5.
- gRPC-web to <https://zjs.zec.rocks/mainnet>, failover
  <https://zcash-mainnet.chainsafe.dev>. (Plain `zec.rocks:443` is gRPC only, for
  native CLI tools; a browser cannot use it.)
- Ironwood proving in the browser.
- Hosted with COOP/COEP headers so WASM threads are available.
- Mainnet from the first milestone.
- Sender flow driven by a ZIP-321 payment URI and QR, so existing wallets work as-is:
  Zodl, Zingo, ZKool2, Vizor and Cake are Ironwood-capable.

The web app itself does not exist yet.

## License

MIT. See [LICENSE](LICENSE).
