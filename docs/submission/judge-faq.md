# Judge FAQ

Twelve questions we expect, answered as they would be live.

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
someone spends it, and a link is one address, so a leak costs that envelope only.

**4. Why Zcash and not Solana-native?** The hidden amount is the point, and only a
shielded pool gives it: on Solana the amount and both parties are public the moment the
link is funded. Solana is here only as an exit, priced first.

**5. Why not just use Vizor gift links?** They are good and we credit them. The
difference is the recipient: Vizor's installs Vizor. Ours needs nothing, and our link
carries no amount.

**6. What happens at NU7?** Nothing in our flow — it introduces no new transaction
format. Testnet activates 2026-10-06 and mainnet 2026-11-05, after submissions close,
which is one reason we build on mainnet only.

**7. How do you make money?** A flat fee per link, 0.0003 ZEC today, paid by the sender
as a second output of the recipient's sweep — a single-output ZIP-321 URI is the only
shape every wallet accepts. Never a percentage, recipients pay nothing, and it is off
until there is a real fee address.

**8. Do group payouts actually work?** The link side does: up to 50 secrets and links
made in the tab, a table of single-output URIs, and a CSV whose amount columns are
`envelope_zec`, what the recipient receives, and `send_zec`, what the sender pays.
Funding them all from one wallet is what M6 owes.

**9. How slow is it on a phone?** Measured, on 2026-09-21, on the live site: an iPhone
16e in Brave, cross-origin isolated, proving on two threads — 7.6 s to open and scan,
8.4 s of witnessing and 5.1 s of proving, **13.5 s** from "Send it on" to done, on the
same 9,166-byte transaction the desktop produces. That was a dry run on a real mainnet
envelope; nothing was broadcast. One device, one run — an older phone will be slower,
and delegated proving via ZIP-374 stays the fallback. Transcript:
`web/docs/M4-VERIFICATION.md`.

**10. Safari?** WebKit itself is fine with threads: the iPhone 16e run above was Brave
on iOS, which is WebKit, and it was cross-origin isolated and proved on two threads. What
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
