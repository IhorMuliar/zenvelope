# Zenvelope

[![CI](https://github.com/IhorMuliar/zenvelope/actions/workflows/ci.yml/badge.svg)](https://github.com/IhorMuliar/zenvelope/actions/workflows/ci.yml)

**Send shielded money as a link. No wallet, no address, no amount on screen.**

Built for the [Colosseum Crypto World's Fair 2026](https://colosseum.com), Zcash track.

**Live demo: <https://zenvelope.netlify.app>** — open it in any browser, no wallet needed.

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
2. **USDC or SOL on Solana**, optional, routed through a third-party swap rail. It is
   shown behind an explicit trust-boundary warning: this leaves the shielded pool, and
   here is what you give up. The rail is not ours, and we never hold funds on either
   side. Every cost is on screen before anything is committed, including the rail's own
   house fee that the rail does not display, and the recipient needs no Solana wallet:
   the page can make them a keypair. A failed swap refunds to the envelope's own
   address, so the same link opens it again.

## Group envelopes

One sender, N recipients, fixed amounts per link. For payroll, contractor payouts,
community distributions, and holiday gifting. Fixed split only. No random split, and
never a payment by the recipient to open an envelope.

**Group envelopes (preview).** The create form already takes an amount per envelope
and a count of 1 to 50: above one it generates that many secrets and links in the
browser, shows a table of single-output ZIP-321 URIs, and offers a CSV
(`index,link,address,envelope_zec,send_zec,memo,payment_uri`). Two amount columns,
because they answer two questions: `envelope_zec` is what the person who opens that
link receives, and `send_zec` is that plus the flat service fee — the amount the
`payment_uri` asks the sender's wallet for. The secrets live in the tab and in that
file and nowhere else. Batch funding from one wallet is what M6 still owes.

## Fee

The sender funds a single output of *envelope amount + flat fee*. The fee is paid to
Zenvelope when the recipient opens the envelope, as a second output in the sweep
transaction. One output keeps the ZIP-321 URI compatible with every sender wallet.
It is a flat service fee, not a percentage. Recipients pay nothing. Live since
2026-09-24; an envelope too small to cover both the network fee and the service fee says
so before proving.

## What we are not

Not a custodian, not an exchange, not a bridge. No float, no in-house conversion, no
account, no KYC, no server-side keys. The design is chosen so that no entity in the
flow is a MiCA crypto-asset service provider or a money transmitter.

## Safety

A link that carries money is the exact shape of a wallet drainer, so the product is
written against that likeness rather than around it.

**We will never ask for your seed phrase, your wallet password, or a wallet
connection.** There is no wallet-connect code path in this repository and no screen
that accepts key material typed by a person. Opening an envelope asks for one thing:
where the money should go — a Zcash address you paste, or a wallet the page generates
in your browser. The open page is the only place funds move.

The word **"claim"** appears on no screen, in any tense or compound. It is the top
drainer lure, so it is banned outright and the ban is enforced by tests, not by
memory: `web/src/copy/en.ts` is the single source of the sender-side strings and
`web/src/copy/en.test.ts` audits them, while the Playwright suites assert it against
the rendered text of every screen.

**How to check a Zenvelope link yourself**, without trusting us, set out in full on
`/how`:

1. **Read the host in the URL bar.** Everything before the first single `/` is the
   host; a look-alike spelling or an extra word before the dot is a different site.
2. **The secret after the `#` never leaves your browser.** Browsers do not send the
   fragment to any server. Open the network panel before you open the envelope and
   watch that it appears in no request.
3. **Read the code that runs on you.** The whole app is MIT and in this repository.
   There is no backend to audit because there is no backend.
4. **Check the transaction on a block explorer.** The funding transaction is ordinary
   public Zcash data on `mainnet.zcashexplorer.app`; the amount stays shielded there,
   readable only by whoever holds the link.

Leaving the shielded pool is the one irreversible privacy decision in the flow, so it
gets a screen of its own before any Solana exit: what becomes public, that a
third-party swap service sees the transaction, that a spread and fees apply, and that
Zenvelope is not the swap provider and never holds the funds — behind a required
"I understand this leaves the shielded pool" tick
(`web/src/components/TrustBoundary.tsx`).

## Status

Milestones, in dependency order. Full spec in [docs/BUILD_SPEC.md](docs/BUILD_SPEC.md),
product one-pager in [docs/PRODUCT.md](docs/PRODUCT.md), decision log in
[docs/DECISIONS.md](docs/DECISIONS.md).

Measured on an iPhone 16e (Brave on iOS, 3 threads): under 8 seconds from "Send it on"
to done, 4.4 s of it proving — 2026-09-21, dry run against the live site, nothing broadcast
([web/docs/M4-VERIFICATION.md](web/docs/M4-VERIFICATION.md)).

State on 2026-09-24:

- **The flat service fee is live.** The sender pays envelope + 0.0003 ZEC in one output;
  the fee goes to the service address when the recipient sends on. An envelope too small
  to cover the network fee and the service fee says so before proving starts.
- **Two-phase open.** A link finalised with its funding height reveals the amount in
  about 0.6 s and finishes the spent check in about 1.5 s on a desktop (fee envelope, dry
  run, 4 threads), against 31 s for a link that still scans from creation. An envelope
  already opened says "already opened" and shows the spending transaction.
- **The new wallet restores elsewhere.** The M3 destination (24 BIP-39 words, account 0,
  the same `new_wallet` the page runs) was restored by the owner in the Noir
  browser-extension wallet and shows 0.0009 ZEC shielded, the exact sweep output. Zodl
  uses the same seed scheme. Noir's unified address differs because it adds a
  transparent receiver ([M3-VERIFICATION.md](web/docs/M3-VERIFICATION.md) §10).
- **CI on every push:** Rust tests and clippy, both wasm builds with a shared-memory
  check, the web tests, and the mock browser suite.

- [x] **M0** Repo, README one-pager, license, arena project draft, first builder update posted.
- [x] **M1 (done)** Create a link on mainnet: secret, derived address, ZIP-321 URI, QR, fee in the amount. M1 done 2026-09-20: first envelope funded from Zodl on mainnet, Ironwood note confirmed by zcash-devtool (tx 281e9f7b…341d43, block 3490472). Verification transcript in [web/docs/M1-VERIFICATION.md](web/docs/M1-VERIFICATION.md).
- [x] **M2 (done)** Open a link on mainnet: scan, decrypt, show the amount. M2 done 2026-09-21: envelope opened in the browser on mainnet, Ironwood note found and amount revealed — 64 blocks scanned from the link's birthday to the chain tip in 2.0 s, the note matching the zcash-devtool oracle field for field (tx 281e9f7b…341d43, block 3490472, 0.0013 ZEC). The scan also proved that a ZIP-321 `message=` never reaches the chain, so the sender's text now travels in the `memo=` parameter and is encrypted on-chain. Verification transcript in [web/docs/M2-VERIFICATION.md](web/docs/M2-VERIFICATION.md).
- [x] **M3 (done)** Spend from the link to a pasted Zcash address in the browser, on mainnet, with in-browser Ironwood proving. End to end. **M3 done 2026-09-21: envelope swept in the browser on mainnet, tx `ba0f91cfe7ca33dd269b692bf80027df2681a321215e90ab28c2a56260fa2aad`, verified by zcash-devtool.** The whole flow runs through the product on the real core: the envelope opens, the Ironwood proving key warms in the background while the recipient reads, a pasted unified address or a wallet generated in the page is reviewed with its fees, and the browser witnesses the real M1 Ironwood note against the chain's own commitment tree, builds a V6 transaction with two Ironwood actions, **proves it in WASM** and broadcasts it — 40.3 s from "Send it on" to `Sent.`, mined in block 3,491,056. The 130,000 zatoshi envelope paid out 90,000 to the recipient, 30,000 to the Zenvelope fee envelope and 10,000 to the miners, and three independent view-only zcash-devtool wallets confirm each of those three numbers on-chain. Transcript in [web/docs/M3-VERIFICATION.md](web/docs/M3-VERIFICATION.md) (§9 is the broadcast); design, anchor policy and the destination matrix are in [crates/core/README.md](crates/core/README.md).
- [ ] **M4 (in progress)** Drainer-safe copy, trust-boundary screens, fresh in-browser wallet with seed export — and the proving work that makes them usable. **In progress 2026-09-21: the core moved into a Web Worker and proves on 4 threads, cutting a desktop dry sweep from 49 s to 23 s tap to done, alongside the drainer-safe copy, the trust-boundary screen and a group-envelope preview with CSV export.** Transcript in [web/docs/M4-VERIFICATION.md](web/docs/M4-VERIFICATION.md).
- [x] **M5 done 2026-09-24: live ZEC to USDC-on-Solana exit, tx `b7b2a81bbbde3b0e17197d581e40f810ef169497431170186eb4382f9d4c6838`, USDC received.** A 0.0103 ZEC envelope opened on the live site went through the trust boundary, a live 1Click quote and a real `t1` deposit address; the browser swept 0.00985 ZEC to it (block 3,494,474) and 14.400612 USDC arrived at the owner's Solana wallet 8 minutes after the tap (Solana tx `2VTVZPoz…HU9wE`), confirmed independently by zcash-devtool, Solana RPC and the rail's own status. Transcript in [web/docs/M5-VERIFICATION.md](web/docs/M5-VERIFICATION.md#7-live-swap-verified).
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
  and mitigate it with what actually exists today: static hosting with no backend and no
  analytics; a strict `Content-Security-Policy` — `default-src 'none'`, no
  `unsafe-inline`, `connect-src` limited to the two lightwalletd pairs and the swap rail
  — delivered as a response header by both committed host configurations and as a
  `<meta>` fallback in `index.html` for any host that reads neither; the wasm core loaded
  from our own origin only, in a worker; `npm` and `cargo` lockfiles committed, with
  three runtime npm dependencies; and the secret stripped out of the URL as soon as it
  has been read (DECISIONS D15). **Planned, and not yet true:** subresource integrity
  hashes on the built assets, and reproducible builds. Neither exists — the wasm is built
  by `scripts/build-core.sh` with no hash pinning, `web/src/wasm/` is gitignored, and the
  threaded core is loaded by a bare `import(url)`, which cannot carry SRI. Until they do,
  the honest statement of the trust model is that a recipient trusts the host to serve
  the code this repository contains.
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

The web app exists and runs the real core: it creates an envelope on mainnet, shows the
ZIP-321 URI and QR, re-derives the address from the link alone, and opens a funded
envelope — scanning and decrypting the Ironwood note in the browser, with the secret
never leaving the tab. The spend core is in too: `sweep_envelope` witnesses every
note the envelope holds, builds one transaction that spends them all, proves it in WASM
and broadcasts it, driven by the open page's own screens — to a pasted address, a wallet
generated in the page, or the Solana exit. The create page watches for the payment and
hands out the final link; an envelope already opened says so.

## License

MIT. See [LICENSE](LICENSE).
