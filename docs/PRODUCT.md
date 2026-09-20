# Zenvelope

**Send shielded money as a link. No wallet, no address, no amount on screen.**

## What it is
Zenvelope takes the idea behind ZIP-324, Zcash's 2019 draft for
URI-encapsulated payments, to the open web and to the Ironwood pool. A sender
funds a link from a shielded ZEC balance. The recipient opens the link in any
browser and takes the money out. No wallet, no install, no address exchange,
and the amount is not in the link: it stays hidden from everyone, including the
recipient, until the envelope is opened. Prior art we build on: zplash (2026,
ZIP-324 on Sapling with browser proving) and Vizor gift links (2026, recipient
installs Vizor). See DECISIONS.md.

## How it works, in one paragraph
The link contains a secret in the URL fragment. That secret derives a shielded
Zcash address and its viewing and spending keys. The sender's wallet pays to
that address. When the recipient opens the link, their browser uses the viewing
key to find the note and reveal the amount, then uses the spending key to move
the funds where they choose. The secret never leaves the browser and never
reaches our server. We cannot see, freeze, or take the money. We are a website
that hosts the open-source code, nothing more.

## Where the money can go on open
1. **Shielded ZEC** to any Zcash address the recipient pastes, or to a fresh
   in-browser Zcash wallet we generate for them. This is the product.
2. **USDC or SOL on Solana**, optional, routed through a third-party swap rail
   the recipient chooses. Shown behind an explicit trust-boundary warning:
   "This leaves the shielded pool. Here is what you give up." The rail is not
   ours, and we never hold funds on either side.

## Group envelopes
One sender, N recipients, fixed amounts per link. Used for payroll, contractor
payouts, community distributions, and holiday gifting. Fixed split only, no
random split, no payment by the recipient to open.

## What we charge
A flat fee per link, paid by the sender at creation as a separate shielded
output to our address. The fee covers hosting and sponsored costs. It is a
service fee, not a percentage of the amount. Recipients pay nothing.

## What we are not
Not a custodian, not an exchange, not a bridge. No float, no conversion in-house,
no account, no KYC, no server-side keys. The design is chosen so that no entity
in the flow is a MiCA crypto-asset service provider or a money transmitter.

## Who it is for first
- ZEC holders paying someone who has no Zcash wallet.
- Zcash community organizers and NFT mints distributing to many recipients.
- Holiday and Lunar New Year gifting inside the Zcash community.

## Tracks
Primary: Colosseum Crypto World's Fair, Zcash track. Also registered: Solana
track, general awards. Superteam Earn: Ukraine sidetrack, RPC Fast, pitch bounty.
Later: Zcash coinholder retroactive grant, Superteam grant.

## Copy rules
Never use the word "claim" in product copy. It is the top wallet-drainer lure.
Use "open", "receive", "unwrap".
