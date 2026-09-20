# Zenvelope

**Send shielded money as a link. No wallet, no address, no amount on screen.**

Built for the [Colosseum Crypto World's Fair 2026](https://colosseum.com), Zcash track.

## What it is

Zenvelope is the first production implementation of [ZIP-324](https://zips.z.cash/zip-0324),
Zcash's own "URI-encapsulated payment" standard, drafted in 2019 by the Zcash core
team and never shipped. A sender funds a link from a shielded ZEC balance. The
recipient opens the link in any browser and takes the money out. No wallet install,
no address exchange, and the amount is hidden from everyone, including the recipient,
until the envelope is opened.

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

A flat fee per link, paid by the sender at creation as a separate shielded output to
our address. It covers hosting and sponsored costs. It is a service fee, not a
percentage of the amount. Recipients pay nothing.

## What we are not

Not a custodian, not an exchange, not a bridge. No float, no in-house conversion, no
account, no KYC, no server-side keys. The design is chosen so that no entity in the
flow is a MiCA crypto-asset service provider or a money transmitter.

## Status

Milestones, in dependency order. Full spec in [docs/BUILD_SPEC.md](docs/BUILD_SPEC.md),
product one-pager in [docs/PRODUCT.md](docs/PRODUCT.md).

- [x] **M0** Repo, README one-pager, license, arena project draft, first builder update posted.
- [ ] **M1** Create a link on testnet: secret, derived address, ZIP-321 URI, QR, fee output.
- [ ] **M2** Open a link on testnet: scan, decrypt, show the amount.
- [ ] **M3** Spend from the link to a pasted Zcash address in the browser, with WASM proving. ZIP-324 end to end.
- [ ] **M4** Mainnet switch, drainer-safe copy, trust-boundary screens, fresh in-browser wallet with seed export.
- [ ] **M5** Solana receive option via a third-party rail, with the warning screen and a fresh keypair path.
- [ ] **M6** Group envelopes and CSV export.
- [ ] **M7** Submission pack: pitch video, demo video, listings.

## ZIP-324

<https://zips.z.cash/zip-0324> — *URI-Encapsulated Payments*. Status: **Draft**.
Created **2019-07-17**, and still unimplemented in production.

- **Owners:** Jack Grigg, Daira-Emma Hopwood, Kris Nuttycombe
- **Original authors:** Ian Miers, Eran Tromer, Jack Grigg, Kevin Gorham, Daira-Emma Hopwood
- **Credits:** Sean Bowe, Deirdre Connolly, Linda Naeun Lee, George Tankersley, Henry de Valence

The ZIP specifies sending a Zcash payment over any unmodified messaging channel: the
URI encodes the secret spending key of an ephemeral address that already holds the
funds, and the recipient moves them to their own wallet with an ordinary on-chain
transaction. Zenvelope takes that shape and puts the recipient side in a browser
instead of requiring a wallet app.

**Prior art:** [zplash](https://github.com/davisonio/zplash) by davisonio, which proved
that a Zcash light client compiled to WASM can scan and spend from inside a browser.

## Building

Coming with M1. Planned stack:

- Static web app, open source, MIT, hostable anywhere. No backend that touches keys.
- Zcash in the browser: a WASM light client built from `zcash_client_backend`.
- gRPC-web to a public lightwalletd (`zec.rocks:443`, with a fallback).
- Sender flow driven by a ZIP-321 payment URI and QR, so existing wallets work as-is.

There is no product code in this repo yet. M0 is the skeleton.

## License

MIT. See [LICENSE](LICENSE).
