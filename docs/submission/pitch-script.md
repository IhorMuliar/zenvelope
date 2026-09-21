# Pitch video script — 3 minutes

One voice, 432 words at ~140 wpm. Numbers come from the M1–M5 transcripts, unrounded.

## The diagram, 0:00–0:20

Full screen, no talking head. The README's "We never hold funds" picture, animated top to
bottom: **sender's wallet** → *shielded payment* → **the link's address, on-chain** →
*viewing key finds the note, spending key moves it* → a browser holding a key glyph →
**wherever the recipient chooses**. Off to the right, greyed and joined to nothing: **our
server — static HTML, JS, WASM. No keys, no float, no custody.** **`#secret`** stays
inside the browser.

## Voice-over

**Hook, over the diagram — 0:00–0:20**

> Zenvelope sends shielded money as a link. Watch where the money goes: out of your
> wallet, into a one-time Zcash address the link derives, then into the other person's
> browser. Our server is the grey box on the right. It serves files. It never holds funds.

**Problem — 0:20–0:40**

> Paying someone in ZEC today means asking them for an address. Which means they install
> a wallet, write down a seed phrase, and send you a string — all before they have any
> money. Most people stop at step one, and the amount leaks somewhere public.

**Product — 0:40–1:00**

> An envelope is a link. You set an amount and a private message, your own wallet pays a
> QR code, and you send the link on. Whoever opens it needs nothing: no wallet, no
> install, no address. The amount is not in the link; it stays hidden until it is opened.

**How it works — 1:00–1:25**

> The secret is thirty-two random bytes after the hash in the URL, and browsers never
> send that part to a server. It derives a shielded address and its keys. The recipient's
> browser scans Zcash, decrypts the Ironwood note, and proves the spend right there — a
> 750-kilobyte prover, under eight seconds on an iPhone, four and a half of them
> proving.

**Prior art, and what is different — 1:25–1:55**

> We are not first to send ZEC by link, and we say so. ZIP-324 drafted this in 2019.
> Zplash shipped it on Sapling in March, with browser proving, and its recipient pastes
> an address. Vizor shipped gift links in September, and its recipient installs Vizor. We
> build on both. Ours: the recipient needs nothing at all, the amount is not in the link,
> and it runs on Ironwood.

**Traction — 1:55–2:20**

> Everything is mainnet, never testnet. The first envelope was funded from a phone wallet
> — transaction 281e9f7b, block 3,490,472. The sweep is broadcast: transaction
> `ba0f91cfe7ca33dd269b692bf80027df2681a321215e90ab28c2a56260fa2aad`, built and proved inside a browser. Three hundred and ten unit tests,
> twenty-seven end-to-end specs, and a verification transcript per milestone carrying the
> commands behind every number.

**Business and legal — 2:20–2:40**

> We take a flat fee per link, 0.0003 ZEC today, paid by the sender as a second output of
> the sweep. Never a percentage. No custody, no float, no in-house swaps, no accounts.
> That shape is deliberate: it keeps us outside MiCA's service-provider test and money
> transmission.

**Roadmap and ask — 2:40–3:00**

> Next: group envelopes funded from one wallet. The build is live at
> `https://zenvelope.netlify.app`, measured on an iPhone 16e at just under eight
> seconds tap to done, in a dry run on mainnet. We are asking the Zcash track to back the case where a shielded
> payment reaches somebody who has nothing yet. The code is MIT today.

## Shot list

| Time | Shot |
| --- | --- |
| 0:00 | The diagram, animated arrow by arrow |
| 0:20 | A phone chat, "what's your address?", then an abandoned install |
| 0:40 | `https://zenvelope.netlify.app`: **Create envelope**, the link, QR, breakdown |
| 1:00 | URL bar, the secret after `#` highlighted, network panel carrying none of it; then `/e` on mainnet — scan bar, reveal; cut to the iPhone 16e screen recording, footer `proving: 3 threads`, the clock at 7.9 s |
| 1:25 | Three stills: zip-0324, zplash.vercel.app, the Vizor v0.0.55 note |
| 1:55 | The explorer on 281e9f7b…341d43, then `ba0f91cfe7ca33dd269b692bf80027df2681a321215e90ab28c2a56260fa2aad`; tests green |
| 2:20 | The review screen's fee lines, then README "What we are not" |
| 2:40 | The group table and CSV, then the `https://zenvelope.netlify.app` end card |
