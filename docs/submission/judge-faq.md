# Judge FAQ

Fourteen questions we expect, answered as they would be live. State as of 2026-09-24.

**1. Do you ever hold the funds?** No, and no code path could. The money sits at a
one-time shielded address derived from the link secret, which lives only in the URL
fragment — browsers never send that to a server. We serve static files: no account, no
float, no server-side key. If the site vanished, an unopened envelope would still be
spendable from the repo.

**2. A link carrying money is the shape of a wallet drainer. Why not this one?** No
wallet-connect path exists in the repo, and no screen takes key material typed by a
person. "We will never ask for your seed phrase, your wallet password, or a wallet
connection" is on the landing page and `/how`. The top lure word is banned and the ban is
enforced by tests; `/how` teaches four checks that need no trust in us.

**3. What if the link leaks?** Whoever holds it can open it — it is a bearer instrument
and we say so. But the amount is not in the link, so a leak discloses nothing until
someone spends it, and a link is one address, so a leak costs that envelope only. If two
people open the same link at once, the network settles it: we tested it on mainnet on
2026-09-24 with two browsers sending at nearly the same moment. One sweep landed; the other
was refused by the network ("another transaction in the mempool has already spent some of
its inputs") and said so, and the money arrived once. Anyone opening it after that sees
"This envelope was already opened" with the transaction.

**4. Why Zcash and not Solana-native?** The hidden amount is the point, and only a
shielded pool gives it: on Solana the amount and both parties are public the moment the
link is funded. Solana is here only as an exit, priced first.

**5. Why not just use Vizor gift links?** They are good and we credit them. The
difference is the recipient: Vizor's installs Vizor. Ours needs nothing, and our link
carries no amount.

**6. What happens at NU7?** Nothing in our flow — it introduces no new transaction
format. Testnet activates 2026-10-06 and mainnet 2026-11-05, after submissions close,
which is one reason we build on mainnet only.

**7. How do you make money?** A flat fee per link, 0.0003 ZEC, live on the site since
2026-09-24. The sender pays envelope plus fee in one output — a single-output ZIP-321 URI
is the shape every wallet accepts — and the fee goes to the service address as a second
output when the recipient sends the money on. Never a percentage, and recipients pay
nothing. An envelope too small to cover both the network fee and the service fee says so
before any proving starts.

**8. Do group payouts actually work?** The link side does: up to 50 secrets and links
made in the tab, a table of single-output URIs, and a CSV whose amount columns are
`envelope_zec`, what the recipient receives, and `send_zec`, what the sender pays.
Funding them all from one wallet is what M6 owes.

**9. How slow is it on a phone?** Measured, on 2026-09-21, on the live site: an iPhone
16e in Brave, cross-origin isolated, proving on three threads — 5.5 s to open and scan,
3.2 s of witnessing and 4.4 s of proving, **7.9 s** from "Send it on" to done — under 8
seconds, on the same 9,166-byte transaction the desktop produces. The proving key warms
in the background while the envelope is read, so the wait for it at tap time was 0.0 s.
That was a dry run on a real mainnet envelope; nothing was broadcast. One device, one
run — an older phone will be slower, and delegated proving via ZIP-374 stays the
fallback. For scale, the closest published figure we know of is ChainSafe's 5.4 s
desktop-browser benchmark on a MacBook Air M2; we are not aware of a prior
mobile-browser number. Transcript: `web/docs/M4-VERIFICATION.md`.

Opening is faster than sending. Since 2026-09-24 a link is finalised with the height of
its funding block, and the page reveals the amount and then verifies: on a desktop (the fee
envelope, dry run, four threads) the amount is on screen in about **0.6 s** and the spent
check finishes in about **1.5 s**, against **31 s** for a link that still scans from the
moment it was created.

**10. Safari?** WebKit itself is fine with threads: the iPhone 16e run above was Brave
on iOS, which is WebKit, and it was cross-origin isolated and proved on three threads. What
matters is the headers and the probe, not the engine — without cross-origin isolation or
wasm threads the core falls back to the single-threaded package, same transaction, and on
the desktop that is roughly 47 s instead of 23 s. Any probe failure falls back rather
than blocking an envelope; the footer says which package won and on how many threads.

**11. What does the lightwalletd gateway see?** An IP, the block ranges a tab asks for,
and the raw transaction at broadcast — not the secret, the viewing key or the amount,
since trial decryption happens in the tab. The birthday height does narrow when an
envelope was made; your own endpoint removes even that.

**12. What if zec.rocks goes down?** The app fails over to
`zcash-mainnet.chainsafe.dev`, and the endpoint is configuration, not architecture: any
gRPC-web gateway works, including your own. An outage delays scanning or broadcast; it
never strands funds, since the money is on-chain and the keys are in the link.

**13. What if someone opens a link that was already opened?** The page says "already
opened" and shows the spending transaction. The scanner checks the envelope's nullifiers
as it walks the chain, so a spent note is recognised from the chain itself, not from any
record we keep — we keep none.

**14. Is the wallet the page makes for a recipient a real wallet?** Yes. "A new wallet in
this browser" is 24 BIP-39 words, account 0 — the seed scheme Zodl uses too. On
2026-09-24 the owner restored the M3 destination wallet, minted by that same core
function, in the Noir browser-extension wallet: it shows 0.0009 ZEC shielded, exactly
what the M3 sweep sent. Noir's unified address reads differently because it adds a
transparent receiver; the keys are the same. Transcript: `web/docs/M3-VERIFICATION.md`
§10.
