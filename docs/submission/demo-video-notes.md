# Demo video notes: the 3-minute cut

**File:** `/root/Projects/web3-sweep/zenvelope-video/demo-3min.mp4` (not in the repo).
1280x720, H.264, 25 fps, **2:58.7 (178.72 s)**, no audio track. The captions are burned in
(libass, DejaVu Sans, white on a dark box, bottom centre). The source subtitles sit beside it
as `demo-3min.srt`. Thumbnails: `demo-thumb-1-landing.png`, `-2-create-qr.png`,
`-3-open-reveal.png`, `-4-sent-mainnet.png`, `-5-solana-usdc-paid.png`, same folder.

Made on 2026-09-24. **Nothing was broadcast to make it.** The new footage is of the live site
`https://zenvelope.netlify.app`, recorded with Playwright's headless Chromium (viewport only,
so no URL bar). It covers two freshly created, unfunded envelopes, plus one explorer page.
Everything that moved money is older footage of runs already written up in
`web/docs/M3-VERIFICATION.md` §9 and §11 and `web/docs/M5-VERIFICATION.md` §7.

**Secrets on screen: none.** On the create and group pages, CSS masks the envelope link and
every `row-link` cell. In the CSV card, each link reads `…/e#••••••`. The only QR shown encodes
a ZIP-321 payment URI (an address and an amount). No clip shows a mnemonic, a Solana secret
key or a URL bar. Playwright's full-page screenshot frames inside the older recordings were
found by a luma check on the right edge of the frame, and the cuts skip them.

## Cut list

Times are in the final video. "Speed" is the playback rate against the source.

| Final | Section | Source | Source range | Speed |
| --- | --- | --- | --- | --- |
| 0:00.0–0:08.0 | 1. Landing, tagline | new capture `create` (live site) | 1.2–9.2 s | 1x |
| 0:08.0–0:18.7 | 2. Create: 0.001 ZEC, "Happy birthday", link (masked), QR | new capture `create` | 9.2–19.9 s | 1x |
| 0:18.7–0:28.0 | 2. QR and breakdown, zoomed still | frame of `create` at 19.5 s, crop 800x450 | still | — |
| 0:28.0–0:38.0 | 3. "Paid from Zodl on mainnet, block 3,494,469" card over the create page, dimmed | generated card | still | — |
| 0:38.0–0:40.4 | 4. Open: reading the link, "You have an envelope", scan | `m5-live-solana.mp4` | 1.0–3.4 s | 1x |
| 0:40.4–0:48.6 | 4. Reveal: 0.0103 ZEC, "Solana test", Ironwood, block 3,494,469 | `m5-live-solana.mp4` | 3.8–12.0 s | 1x |
| 0:48.6–0:57.0 | 4. The fee envelope opened on the live site: 0.0003 ZEC, block 3,491,056, too small to send on | `web/docs/fee-live.png`, pan | still | — |
| 0:57.0–1:06.0 | 4. Timing block (open/scan 1.1 s … total 84.4 s) | frame of `m5-live-solana.mp4` at 136 s | still | — |
| 1:06.0–1:14.0 | 5. The first mainnet send: scan ends, 0.0013 ZEC revealed | `m3-broadcast.mp4` | 11–19 s | 1x |
| 1:14.0–1:24.2 | 5. Witness, keys, proving, sending, with the elapsed clock | `m3-broadcast.mp4` | 29.9–70.3 s | **4x** |
| 1:24.2–1:32.7 | 5. "Sent." 0.0009 ZEC, `ba0f91cf…6260fa2aad`, explorer link, "The envelope is now empty." | `web/docs/m3-sent.png`, pan | still | — |
| 1:32.7–1:41.6 | 5. zcashexplorer.app: block 3491056, 3,746 confirmations, shielded, 9,166 bytes | new capture `explorer` (still + clip) | 4.5–8.9 s | 1x |
| 1:41.6–1:49.9 | 6. Trust boundary: four points, the tick, Continue disabled | `web/docs/m5-trust.png`, crop y 930–1770 (the card only), pan | still | — |
| 1:49.9–1:55.9 | 6. Where should it go → Solana, address pasted and checked | `m5-live-solana.mp4` | 36.4–42.4 s | 1x |
| 1:55.9–2:00.7 | 6. The quote: 14.392933 USDC, 0.47% · $0.07, about 8 minutes, 0.25% rail fee line (3 s hold) | `m5-live-solana.mp4` | 42.7–44.5 s + frame at 44.5 s | 1x |
| 2:00.7–2:04.3 | 6. "The swap is set up": deposit address, Send the ZEC | `m5-live-solana.mp4` | 44.6–48.2 s | 1x |
| 2:04.3–2:10.4 | 6. Proving | `m5-live-solana.mp4` | 48.5–133.0 s | **14x** |
| 2:10.4–2:12.7 | 6. "Sent." 0.00985 ZEC | `m5-live-solana.mp4` | 133.2–135.5 s | 1x |
| 2:12.7–2:21.7 | 6. Tracker: all three steps ticked, 14.384176 USDC, Solana tx | `web/docs/m5-live.png` on a card | still | — |
| 2:21.7–2:25.2 | 7. Race, browser B: proving → sending to the network | `concurrent-B.webm` | 124–131 s | **2x** |
| 2:25.2–2:29.7 | 7. "It did not go through": error -25, input already spent | `concurrent-B.webm` | 132–136.5 s | 1x |
| 2:29.7–2:36.7 | 7. Fresh browser afterwards: "This envelope was already opened" | `web/docs/concurrent-after.png`, pan | still | — |
| 2:36.7–2:38.8 | 8. Group: 0.001, count 3, "Team lunch" | new capture `group` (live site) | 1.8–5.9 s | **2x** |
| 2:38.8–2:46.7 | 8. Create envelopes → the table of 3 (links masked) → Download CSV | new capture `group` | 5.9–13.8 s | 1x |
| 2:46.7–2:51.7 | 8. The CSV header `index,link,address,envelope_zec,send_zec,memo,payment_uri,paid_height,final_link` + 3 rows | generated card from the real downloaded CSV | still | — |
| 2:51.7–2:58.7 | 9. End card: zenvelope.netlify.app, github.com/IhorMuliar/zenvelope, "non-custodial · mainnet · open source (MIT)" | generated card | still | — |

Section totals: 8.0, 20.0, 10.0, 28.0, 35.6, 40.1, 15.0, 15.0, 7.0 s.

## Substitutions, and why

| Wanted | Used instead | Why |
| --- | --- | --- |
| Phone shot, Zodl paying the QR | A card over the dimmed create page: "Paid from Zodl on mainnet, block 3,494,469", tx `36a9bfbb…f2de16`, 0.0103 ZEC, memo "Solana test" | No phone footage exists. A create page cannot show "Paid" without funding a new envelope. Block 3,494,469 is the funding of the envelope opened in section 4 and spent in section 6, so the card, the reveal and the tracker all refer to one real envelope |
| A fresh `?dry=1` capture of the fee envelope's final link | The reveal from `m5-live-solana.mp4` (live site, real envelope, 1.1 s open/scan), then `fee-live.png` (the fee envelope opened on the live site), then the timing block from the same M5 run | This session was not allowed to read the fee envelope's secret. The fee envelope also holds only 0.0003 ZEC, below what a send-on needs, so the page stops at "too small to send on" and never reaches the send screen or the timing block |
| Review screen of the first send | Not shown. Caption 9 gives its numbers (0.0013 in, 0.0001 network, 0.0003 fee, 0.0009 received), matching M3 §9 | `m3-broadcast.mp4` jumps from the reveal straight to "Sending it on" (the driver was faster than a frame) |
| "Sent." of the first send, from the video | `m3-sent.png`, the screenshot taken at the same moment | In `m3-broadcast.mp4` the done screen appears only as Playwright's shrunken full-page screenshot frame |
| Trust boundary from the live Solana run | The trust card cropped out of `m5-trust.png` | The live run passed the gate in about one frame. The full screenshot carries the MOCK banner, so the crop keeps only the trust card, which is the same component and copy |
| 25 group envelopes | 3 | The brief asked for N=3. The CSV card shows the real header of the file the page downloaded |

## Voice-over cue points

The captions stand on their own, so the video works silent. For a voice-over, start each line
at the cue. Say **open**, **receive**, **send it on**, never the drainer-lure word that
starts with "cl-".

| Cue | Say (about) |
| --- | --- |
| 0:00 | "Zenvelope. Send shielded Zcash as a link: no wallet, no install, no amount in the link." |
| 0:08 | "I make an envelope: a thousandth of a ZEC and a message. The secret is made here in the browser. Whoever holds the link holds the money, so we blur it." |
| 0:19 | "Any shielded wallet pays this ZIP-321 code: the envelope plus a flat three-ten-thousandths fee." |
| 0:28 | "It was paid from Zodl on mainnet, one shielded payment." |
| 0:38 | "The recipient opens the link. The browser scans Zcash itself and decrypts the note in about a second." |
| 0:49 | "On the live site today, the fee envelope from our first mainnet send opens the same way." |
| 0:57 | "Every send ends with its own timing." |
| 1:06 | "Send it on: the first real send, on the twenty-first." |
| 1:14 | "The proof is built in this browser, on four threads. We sped this up four times. The clock on screen is real." |
| 1:24 | "Sent, and the envelope is empty." |
| 1:33 | "The explorer has it in a block, shielded. The money later showed up in a third-party wallet." |
| 1:42 | "Or take it out to Solana. Leaving the shielded pool needs a tick, and we are not the swap provider." |
| 1:56 | "You see the quote before anything moves: what arrives, the cost of leaving, the time, and the rail's own fee." |
| 2:04 | "The browser pays the rail's one-time deposit address. Proving, sped up." |
| 2:13 | "About eight minutes later: fourteen point three eight USDC on Solana." |
| 2:22 | "Two browsers, one link, both press send. One lands, the network refuses the other." |
| 2:30 | "Open it again later and it says it was already opened, with the transaction." |
| 2:37 | "Group envelopes: many links at once, and one CSV." |
| 2:52 | "Non-custodial, on mainnet, open source. zenvelope.netlify.app." |

## Rebuild

The build script, capture drivers and generated cards are in the session scratchpad, not the
repo: `video/build.sh`, `video/cap/capture.mjs` and `video/cap/cards.mjs`. To rebuild:
cut the segments, concat them, then burn the captions:

```sh
ffmpeg -i assembled.mp4 -vf "subtitles=demo-3min.srt:original_size=1280x720:force_style='FontName=DejaVu Sans,FontSize=11.5,PrimaryColour=&H00FFFFFF,OutlineColour=&H30141414,BackColour=&H30141414,BorderStyle=3,Outline=4,Shadow=0,MarginV=10,Alignment=2,WrapStyle=2'" \
  -an -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart demo-3min.mp4
```
