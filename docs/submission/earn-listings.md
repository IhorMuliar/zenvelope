# Superteam Earn listings

Three submissions off one product. Links are placeholders until hosting and video are
done.

## Ukraine sidetrack

Zenvelope sends shielded money as a link, and the case it was built for is the one where
the person receiving has nothing set up: no wallet, no install, no address, and often no
safe way to publish one. The sender pays a QR from their own Zcash wallet; the recipient
opens the link in a browser, sees the amount for the first time, and moves it to a Zcash
address, a wallet the page makes for them, or — with the privacy cost spelled out first —
USDC or SOL on Solana. The amount is not in the link, so forwarding it through a chat app
discloses nothing, and nobody holds the funds. Mainnet, MIT.
Repo `https://github.com/IhorMuliar/zenvelope` · Demo `<DEMO_URL>` · Video `<DEMO_VIDEO_URL>`

## RPC Fast

Zenvelope is a browser-only Zcash client: no backend, no server-side keys, so every chain
read and the broadcast go straight from the tab over gRPC-web. That makes the endpoint
load-bearing in a way a server-backed app never sees: a recipient's whole experience is
compact-block streaming plus one send. We stream from `zjs.zec.rocks/mainnet` with
ChainSafe as failover — a 64-block scan to the tip took 2.0 s, and a sweep's witness
stage costs 8–9 s of round trips, the largest non-proving cost in the flow. CORS-correct
gRPC-web with headroom moves that number, and we would publish the before and after.
Repo `https://github.com/IhorMuliar/zenvelope` · Demo `<DEMO_URL>`

## Pitch bounty

Three minutes, one voice: the first twenty seconds are a diagram of where the money
actually goes, our server a grey box off to the side holding nothing. Then the problem (a
shielded payment cannot reach someone with no wallet), the product (an envelope is a
link), the mechanism (secret in the fragment, Ironwood note, proved in the browser in
about 24 seconds), prior art named and dated, mainnet traction with transaction ids, and
a flat per-link fee with no custody. Script: `docs/submission/pitch-script.md`.
Pitch `<PITCH_URL>` · Repo `https://github.com/IhorMuliar/zenvelope`

## Ukraine demo day, Oct 9 — slot request (5 lines)

> Hi — I would like a demo slot on Oct 9 for Zenvelope, a Colosseum Zcash-track project.
> It sends shielded ZEC as a link: whoever receives it needs no wallet, no install and no
> address, and the amount is not in the link until it is opened.
> It is live on mainnet — create, pay by QR from a phone, open in a browser, the spend
> proved in that browser in about 24 seconds; 5 minutes is plenty.
> Repo `https://github.com/IhorMuliar/zenvelope`, demo `<DEMO_URL>`. Thank you — `<NAME>`
