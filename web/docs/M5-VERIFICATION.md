# M5 verification — the Solana exit

**Date:** 2026-09-21
**Milestone:** M5, the optional Solana exit through NEAR Intents 1Click (DECISIONS D10, D14).
**Update 2026-09-24: a live swap completed end to end; see [section 7](#7-live-swap-verified).**
Sections 1 to 6 are the 2026-09-21 dry-run record. **In those, nothing was broadcast.** Every run took the `?dry=1` path, `sweep_envelope` was called
with `broadcast: false`, and no Zcash transaction has ever been handed to lightwalletd.
The only real side effect of the whole milestone is a transparent deposit address that
1Click reserved for three days and that nobody paid.

---

## 1. The rail, re-probed live

`https://1click.chaindefuser.com/v0`, no API key, CORS `*`.

```
$ curl -s -o /dev/null -w '%{http_code}' https://1click.chaindefuser.com/v0/tokens
200      # 196 assets
```

The three asset ids the app hard-codes, straight out of that list:

| Asset | `assetId` | decimals | price at 02:31 UTC |
| --- | --- | --- | --- |
| ZEC | `nep141:zec.omft.near` | 8 | $1,511.16 |
| USDC (Solana) | `nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near` | 6 | $0.999697 |
| SOL | `nep141:sol.omft.near` | 9 | $111.77 |

### CORS, exactly

```
$ curl -sD - -o /dev/null -X OPTIONS https://1click.chaindefuser.com/v0/quote \
    -H 'Origin: http://localhost:4197' \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type'
HTTP/2 204
access-control-allow-origin: *
access-control-allow-methods: GET,HEAD,PUT,PATCH,POST,DELETE
access-control-allow-headers: content-type
```

`content-type` is the **only** allowed request header, which is why
`src/lib/oneclick.ts` sends nothing else. A request with no browser-shaped
`User-Agent` (plain `python-urllib`) is answered `403 error code 1010` by
Cloudflare; a browser is not, which is the environment the app runs in.

`public/_headers` gained `https://1click.chaindefuser.com` in its CSP `connect-src`,
and nothing else changed in the policy.

### The minimum, read out of the 400

```
$ for A in 50000 90000 120000 132000; do  # POST /quote, dry, ZEC -> USDC
=== 50000 ===   400  {"message":"Amount is too low for bridge, try at least 132000",…}
=== 90000 ===   400  {"message":"Amount is too low for bridge, try at least 132000",…}
=== 120000 ===  400  {"message":"Amount is too low for bridge, try at least 132000",…}
=== 132000 ===  201  {"quote":{…}}
```

**Minimum on 2026-09-21: 132,000 zatoshi = 0.00132 ZEC ≈ $2.00.** The app never
hard-codes it: `parseMinAmount` reads it out of that sentence, which is the only
place it is ever true.

### What a dry quote costs

`POST /quote`, `dry: true`, `slippageTolerance: 100`, ZEC → USDC:

| `amountIn` | `amountInUsd` | `amountOut` | `amountOutUsd` | `withdrawFee` | spread |
| --- | --- | --- | --- | --- | --- |
| 132,000 zat | $1.9936 | 1.66937 USDC | $1.6689 | 298,357 (0.2984 USDC) | **16.29%** |
| 200,000 zat | $3.0206 | 2.698406 USDC | $2.6976 | 298,718 | **10.69%** |

ZEC → **SOL** at 200,000 zat: `amountOut` 0.026742508 SOL, `amountOutUsd` $2.9791
against $3.0145 in, `withdrawFee` 95,677 lamports — **1.17%**. The difference is
almost entirely the destination withdrawal fee, which is about $0.30 for USDC and
about $0.01 for SOL, and which dominates at these amounts. Both cards say so.

`refundFee` is 32,000 zatoshi in every quote. `timeEstimate` is 454 s, which the
app rounds to "about 8 minutes".

### The 25 bps house fee

Every unauthenticated quote comes back with

```json
"appFees": [{ "recipient": "5880ad2b…47dd", "fee": 25 }]
```

It is the rail's, not ours, and the rail does not display it. `APP_FEE_BPS` and the
line "Includes a 0.25% service fee to the swap provider" put it on the screen.

### A real quote, and status

```
$ curl … -d '{"dry":false,…,"amount":"132000",…}'
201 {"quote":{…,"deadline":"2026-09-24T09:00:00.000Z",
              "timeWhenInactive":"2026-09-24T09:00:00.000Z",
              "depositAddress":"t1Yqx4Hk…96vmd"}}
```

- The deposit address is an ordinary **transparent `t1`**, 35 characters, **no memo
  and no tag**: the address alone identifies the swap.
- We asked for a 3-hour deadline; the server replaced it with one **three days** out.
- `GET /status?depositAddress=…` answers `200 PENDING_DEPOSIT` for it, and `404
  {"message":"Deposit address … not found"}` for an address it has never seen.

### A gap in the rail's own validation

`recipient` is not fully checked. A 32-byte base58 key that is not a wallet — the
USDC **mint** `EPjFWdd5…TDt1v` was what we happened to try — is answered

```
400 {"message":"Internal server error","correlationId":"7282b41b-…"}
```

reproducibly, where an ordinary wallet key on the identical body is answered
`400 Amount is too low for bridge, try at least 132000`. So a "recipient is not
valid" case exists that the rail reports as an internal error. `src/lib/oneclick.ts`
surfaces it as an ordinary `http` error carrying the rail's own words, the screen
shows them, and the button stays pressable — which is the right behaviour when the
other side is somebody else's service. It cost this milestone two failed live runs
before the cause was found, which is why it is written down.

### `refundTo` (this is DECISIONS D14)

| `refundTo` | result |
| --- | --- |
| `u1nxx35rn…` (unified, Orchard) | **201**, priced quote |
| `t1Ju33aC…` (transparent) | **201**, priced quote |
| `zs1z7rejl…` (Sapling) | 400 `refundTo is not valid` |
| `not-an-address` | 400 `refundTo is not valid` |

A **unified** address is accepted. That is what makes D14 possible: the refund
address can be the envelope's own `u1…`, so a failed swap lands back in the
envelope and this same link opens it again, and the recipient is asked for nothing.

---

## 2. What was built

| File | What it is |
| --- | --- |
| `src/lib/oneclick.ts` | The whole rail: tokens, dry quote, real quote, status, the min-amount parser, the effective-cost calculator, a 10 s timeout on every fetch |
| `src/lib/solana.ts` | base58 by hand, address validation (32 bytes, with a reason), a `crypto.subtle` Ed25519 keypair exported in the 64-byte Phantom/Solflare form |
| `src/lib/solanaFlow.ts` | `trust → asset → destination → quote → deposit`, both gates, the three swap-watching stages |
| `src/components/SolanaExit.tsx` | The five screens |
| `src/components/SwapTracker.tsx` | `GET /status` every 20 s after a broadcast |
| `src/copy/en.ts` | `solanaExit`: what the provider sees, the fee line, the minimum, "not the swap provider" |

No dependency was added. `@solana/web3.js` is deliberately not one: it is megabytes
of RPC client and wallet adapters for two functions, on a page that holds somebody's
spending key.

**The `sweep_envelope` call site did not change.** The Solana exit's last act is to
hand the page a `t1`; from there it is the ordinary sweep to a transparent address,
at the ordinary ZIP-317 fee of 15,000 zatoshi, through the one call in `SendOn.send`.

---

## 3. Tests

```
$ npm test
 Test Files  17 passed (17)
      Tests  310 passed (310)
```

New: `src/lib/oneclick.test.ts` (28), `src/lib/solana.test.ts` (15),
`src/lib/solanaFlow.test.ts` (29), plus 9 added to `src/copy/en.test.ts` — 81 of the
310. The 1Click
fixtures are verbatim bodies from the probes above, including the 400 that carries
the minimum.

### Mock end to end

```
$ ZENVELOPE_E2E_PORT=4197 npx playwright test e2e/m5-solana.spec.ts
  5 passed
```

`e2e/m5-solana.spec.ts` runs on the MOCK core with 1Click answered by `page.route`:

1. **The gate.** The card is live; tapping it opens the trust boundary, not a swap.
   Four points, a disabled button, and the tick is the only way through — including
   with the `disabled` attribute deleted from the DOM, because the handler checks the
   same rule the attribute does.
2. **A pasted address**, refused for the charset (a look-alike `0`) and for the length
   (33 bytes), accepted for the real thing; then the dry quote's numbers on screen —
   `1.424851 USDC`, `$1.74` in, `$1.42` out, `18.03%`, "about 8 minutes", the 0.25%
   line — then the real quote's `t1` and deadline, the review at the transparent fee,
   and the dry-run end screen.
3. **A keypair generated here**: 87–88 characters of base58 secret key, shown once,
   gated behind "I saved this key", and the rail is told to pay that address.
4. **The floor**, straight out of the rail's own 400, blocking the deposit address and
   leaving the shielded way out on the screen.
5. **The status poll** after a broadcast (of a MOCK transaction, which reaches no
   network): PENDING_DEPOSIT → PROCESSING → SUCCESS, the Solana txid, and the poll
   stopping once there is nothing left to ask.

The quote request body is asserted too: the rail is quoted on **115,000** zatoshi —
the envelope less the transparent Zcash fee — never on the envelope amount, and
`refundTo` starts `u1`.

Screenshots: [m5-trust.png](m5-trust.png), [m5-quote.png](m5-quote.png).

The whole existing suite still passes: `17 passed, 15 skipped` with no wasm build.

---

## 4. The live run

```sh
cd web && ZENV_M1_FRAGMENT='<secret>.<birthday>' ZENVELOPE_E2E_PORT=4197 \
  npx playwright test e2e/m5-real.spec.ts
```

`e2e/m5-real.spec.ts`, against the real wasm core, the real mainnet M1 envelope and
the **live** 1Click API. Every quote is made from the page's own origin, which is
also the CORS proof. The page is loaded with `?dry=1` throughout.

```
M5 proving: 4 threads
M5 generated Solana address: BiNGHtzX3Ggikzeuao5EmwTjuix1AbboiJKZzRzeKvQD
M5 live dry quote for 0.0009 ZEC: HTTP 400
   {"message":"Amount is too low for bridge, try at least 132000",
    "correlationId":"cf44bec7-…","timestamp":"2026-09-21T03:20:53.449Z"}
M5 live minimum: 132000 zatoshi (0.00132 ZEC)
M5 product minimum line: The swap service will not trade less than 0.00132 ZEC, and
   this envelope is under that. Send it on as shielded ZEC instead, or to a Zcash
   address of your own.
M5 rail message: Amount is too low for bridge, try at least 132000
M5 real deposit address: t1dWDr…JLVR (35 chars) — transparent, no memo;
   deadline 2026-09-24T06:21:00.158Z
M5 live status: PENDING_DEPOSIT
M5 real dry sweep: tap to done 25.9 s
M5 real dry sweep: raw transaction 9200 bytes to t1dWDr…JLVR (35 chars)

  ✓  1 [chromium] › e2e/m5-real.spec.ts:140:3 › M5: the Solana exit against the
       live 1Click API, dry run › quotes live, is told the floor, takes a real
       deposit address, and sends nothing (51.2s)

  1 passed (53.1s)
```

### What that says

- **0.0009 ZEC is under the floor**, live, and the floor is **132,000 zatoshi =
  0.00132 ZEC**, read out of the rail's own sentence.
- **The envelope is under it too.** 130,000 zatoshi less the 15,000 transparent
  ZIP-317 fee is 115,000, so the product refuses and says why, in its own words with
  the rail's underneath, and leaves the shielded destinations one tap away. That is
  the correct outcome for this envelope, not a failure of the path.
- **A real deposit address was obtained**: transparent, 35 characters, `t1…`, no memo,
  watched until **2026-09-24** — three days, set by the server against the three hours
  we asked for. `GET /status` on it answers `PENDING_DEPOSIT`, live.
- **The keypair was made in the browser** by `crypto.subtle` Ed25519 and exported in
  the 64-byte Phantom/Solflare form; the address above is the public half.
- **The sweep to that `t1` is real and was built and proved in the browser**: the
  review screen showed 0.0013 ZEC in, the 0.00015 transparent ZIP-317 fee and
  0.00115 ZEC out, and **25.9 seconds** from "Send it on" to the done screen on four
  threads, producing **9,200 bytes** of signed transaction. (M3's shielded sweep was
  9,166 bytes; a transparent output is a few dozen bytes more.)
- **Nothing was sent.** `broadcast: false` throughout, the done screen reads "Dry run
  complete.", there is no explorer link, and the envelope is stated to be intact. The
  test asserts every one of those, so a run that silently broadcast would fail here.

The deposit address is redacted here because it is a live address somebody could pay
by mistake; it expires on 2026-09-24 either way.

---

## 5. What is not proved

- **No refund has been paid to a unified address.** Nothing was broadcast, so no swap
  has ever failed. The evidence for D14 is that the rail's own validator accepts a
  `u1…` as `refundTo`; the override field exists for the residual risk.
- **No swap has completed.** The status sequence is proved against `page.route`; the
  live `GET /status` was only ever seen at `PENDING_DEPOSIT`, which is correct for a
  deposit address nobody paid.
- **The quoted price is not a promise.** 1Click prices a swap when the ZEC arrives,
  which is minutes after the quote. `minAmountOut` (the slippage floor) is in the
  quote and the app sends `slippageTolerance: 100` (1%).

---

## 6. Merged onto the multi-note sweep

M5 was built against the one-note `sweep_envelope` signature. `main` had meanwhile
moved to the multi-note sweep (70e17c2), where `sweep_envelope` takes an **array** of
notes and `sweepAmounts`/`networkFeeFor` take a spend count, because the ZIP-317 action
count — and so the miner fee — depends on how many notes are spent.

The merge kept both, and the one place the two milestones met is
`web/src/components/SendOn.tsx`:

- `SendOn` takes `notes: FoundNote[]` **and** `envelopeAddress` (the M5 refund target,
  DECISIONS D14). The sweep hands the core every note it was given, in one transaction.
- The number the rail is quoted on is the same arithmetic the review screen does, with
  the same spend count:

  ```ts
  const swapInputZat = sweepAmounts(
    inEnvelopeZat,        // the sum of every note found
    "transparent",        // a 1Click deposit address is always a t1
    SWEEP_FEE_ZAT,
    notes.length,         // the spend count sets the ZIP-317 action count
  ).receiveZat;
  ```

  So the quote is `sum(notes) − network fee − flat fee`, never the envelope amount, and
  a two-note envelope is quoted on a number that the sweep can actually deliver.
- The Solana path's `sweep_envelope` call is the ordinary one. There is still only one
  call site, and it now passes the notes array.

`e2e/m5-real.spec.ts` was made fee-aware at the same time: the flat Zenvelope fee is
only charged when the build had a `VITE_FEE_ADDRESS`, so the expected receive is
0.00115 ZEC without one and **0.00085 ZEC** with one (130,000 − 15,000 − 30,000). Both
are under the rail's floor, which is what the run asserts.

### The merged tree, green

| | |
| --- | --- |
| `cargo test` | **81 passed**, 0 failed, 2 ignored in `zenvelope-core` (+ 3 passed, 3 ignored in the integration tests) |
| `node scripts/smoke-core.mjs` | **17 checks passed** against the freshly built single-threaded package |
| `npm test` (vitest) | **319 passed** in 17 files |
| `npm run build` | clean, `tsc -b` included |
| e2e, MOCK core (wasm moved aside), port 4203 | **17 passed, 17 skipped**, 0 failed |
| e2e, real core + live 1Click + `VITE_FEE_ADDRESS`, port 4203 | **17 passed, 17 skipped**, 0 failed |

The real run reports the same shapes as before the merge: proving key warm 17.3 s on
four threads, M3's shielded dry sweep 9,166 bytes at 24.8 s tap to done, and the M5
dry sweep to a live `t1` **9,200 bytes at 25.7 s**, with the live floor still
132,000 zatoshi and `GET /status` answering `PENDING_DEPOSIT`.

**Nothing was broadcast in any of it.** Every sweep ran from `/e?dry=1`, the core's own
`SweepResult.broadcast` came back `false`, no explorer link was rendered, and the M1
envelope still holds its 0.0013 ZEC.

---

## 7. Live swap, verified

**Date:** 2026-09-24. **Site:** https://zenvelope.netlify.app (production build, no MOCK
badge, no `?dry=1`). **Browser:** Playwright's own headless Chromium, 1280x720, video on.
The owner funded the envelope from Zodl and approved spending it through the Solana exit;
the destination is the owner's own Solana wallet.

### The envelope

| | |
| --- | --- |
| Funded | 0.0103 ZEC (1,030,000 zat), memo "Solana test", Ironwood |
| Funding tx | `36a9bfbb5a147e87da094b855d9d6cb7248090b2e852915f27f02eac61f2de16` |
| Mined | block 3,494,469, 10:25:16 UTC |
| Envelope address | `u1wp5m5urnc0henz5t7krccfceuspfhuavpaxfs365prpzvv8kyk5kecm0440v45jk9rvp3qjlhadfqvv88h2ht354gzfxhve3synrqv5h` |
| Link opened | `/e#<secret>.3494469` (birthday replaced by the funding height) |

Independent oracle before the run (`zcash-devtool` view-only wallet from the UFVK, birthday
3,494,440): `total 1030000`, one Ironwood output of 0.0103 ZEC in the tx above.

### On the page (UTC)

| Time | Step |
| --- | --- |
| 10:29:53 | page loaded, open tapped |
| 10:29:55 | reveal: **0.0103 ZEC**, "Solana test" |
| 10:29:56 | spend check done, send-on controls shown |
| 10:30:28 | Keys ready (warm 32.7 s) |
| 10:30:33 | USDC chosen, address pasted ("That is a valid Solana address"), **dry quote** |
| 10:30:38 | **real quote**, deposit address |
| 10:30:40 | review, **Send it on** tapped |
| 10:32:05 | **Sent.** (84.4 s tap to done) |

**Dry quote** (`POST /quote`, `dry: true`, `amount: 985000`):

| amountIn | amountInUsd | amountOut | amountOutUsd | minAmountOut | withdrawFee | spread | time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.00985 ZEC | $14.4582 | 14.392933 USDC | $14.3900 | 14.249003 | 10,089 (0.0101 USDC) | 0.47% · $0.07 | 452 s, "about 8 minutes" |

No minimum was hit: 985,000 zat is far above the rail's floor, so no `swap-minimum` line
appeared. `refundFee` 32,000 zat. `refundTo` was the envelope's own `u1` (D14).

**Real quote** (`dry: false`): amountOut **14.384176 USDC** ($14.3813), minAmountOut
14.240334, spread on the review 0.53% · $0.08. Deposit address **`t1MALE…bXKBv6`**
(transparent, 35 chars, no memo), deadline 2026-09-27T13:30:35Z: we asked for 3 hours and
the server again set it three days out.

**Review screen:** in the envelope **0.0103 ZEC**, network fee **0.00015 ZEC**, Zenvelope
fee **0.0003 ZEC**, you receive (amount to the rail) **0.00985 ZEC**, pays out to
`8UEoEwqeTk…xp47egfndB`.

**Done screen:** "Sent.", 0.00985 ZEC, tx
`b7b2a81bbbde3b0e17197d581e40f810ef169497431170186eb4382f9d4c6838`,
[zcashexplorer.app](https://mainnet.zcashexplorer.app/transactions/b7b2a81bbbde3b0e17197d581e40f810ef169497431170186eb4382f9d4c6838),
"The envelope is now empty."

```
OPEN/SCAN 1.1 s · KEYS (WARM) 32.7 s · WAITING FOR KEYS 0.0 s · WITNESS 2.6 s
PROVING 80.7 s · SEND 0.5 s · TOTAL TAP-TO-DONE 84.4 s
proving: 4 threads · hardwareConcurrency 8 · Chrome on Linux · gateway zjs.zec.rocks
```

### The swap tracker

| Time (UTC, page saw it) | Rail `updatedAt` | Status |
| --- | --- | --- |
| 10:32:05 | 10:30:38 | `PENDING_DEPOSIT` |
| 10:38:26 | 10:38:19 | `PROCESSING` (deposit 0.00985 ZEC seen, intent `F4wmjnBG…3onJ`) |
| 10:38:46 | 10:38:39 | **`SUCCESS`**, Solana tx `2VTVZPozrLb9CfcEYM5UNZi3jAYCgKbpFSwu4g4Vwjz2y6uqyX4EkAiAPbUYK1K7MkRyD8qdKaeuUVzQCRkHU9wE` |

Tap to USDC paid out: **7 min 59 s**. The Zcash sweep mined in block 3,494,474 at
10:34:25, so the rail took about 4 minutes after the block. Final tracker:
[m5-live.png](m5-live.png).

### Independent confirmation

**Zcash, oracle** (`zcash-devtool`, same view-only wallet, synced to 3,494,479):
`total 0`; tx `b7b2a81b…4c6838` listed, mined 3,494,474, spending the 0.0103 ZEC note.
Blockchair decodes the same tx as v6, 9,200 bytes, one transparent output of
**985,000 zat to `t1MALE…bXKBv6`**. The rest of the 1,030,000 is the 15,000 ZIP-317 fee and
the **30,000 zat Zenvelope fee** as a shielded output to the owner's Zodl fee address
(`u1svezq8j…c39`), which a view key on the envelope cannot see into by design; the
arithmetic closes exactly.

**Solana, public RPC** (`api.mainnet-beta.solana.com`): `getTransaction 2VTVZPoz…HU9wE`,
slot 450,004,012, block time 10:38:39 UTC, `err: null`. The destination's USDC token
account (`FCTEDFhj…ivQs`, mint `EPjFWdd5…Dt1v`) went **476.106683 → 490.507295 USDC,
+14.400612**. `getTokenAccountsByOwner` now reads 490.507295.

**1Click, `GET /v0/status?depositAddress=t1MALE…`**, final:

```json
{
  "status": "SUCCESS",
  "updatedAt": "2026-09-24T10:38:39.000Z",
  "swapDetails": {
    "depositedAmount": "985000", "depositedAmountUsd": "14.408777000000",
    "amountIn": "985000", "amountInUsd": "14.408777000000",
    "amountOut": "14400612", "amountOutFormatted": "14.400612",
    "amountOutUsd": "14.397285458628",
    "slippage": -11, "refundedAmount": "0", "refundReason": null,
    "refundFee": "32000", "withdrawFee": "10087",
    "intentHashes": ["F4wmjnBGFSrRdHRcJWmkFSLP7kdCaSvXHZS8ojSC3onJ"],
    "nearTxHashes": ["4Fam5VgpPkhzRcX9ULdxDDPxtUpB5FUCkFbvua4cKRTc",
                     "FQXRFgFRhPWE321MCCvd5o2Vxa7xfCec5QKNtA2w3KfP"],
    "originChainTxHashes": [],
    "destinationChainTxHashes": [{"hash": "2VTVZPozrLb9CfcEYM5UNZi3jAYCgKbpFSwu4g4Vwjz2y6uqyX4EkAiAPbUYK1K7MkRyD8qdKaeuUVzQCRkHU9wE", "explorerUrl": ""}]
  }
}
```

The payout beat the quote: 14.400612 USDC against 14.384176 quoted (slippage −11 bps).

### Effective cost

At the rail's own deposit price, $1,462.82/ZEC (14.408777 / 0.00985):

| | ZEC | USD |
| --- | --- | --- |
| Envelope in | 0.0103 | $15.067 |
| Zcash network fee (ZIP-317, transparent) | 0.00015 | $0.219 |
| Zenvelope fee | 0.0003 | $0.439 |
| Rail (rate, withdrawal fee, house fee) | | $0.011 (0.08% of what it received) |
| **USDC out** | | **14.400612 USDC = $14.397** |
| **Total cost of leaving** | | **$0.670, 4.45% of the envelope** |

At this size the rail is nearly free; the fixed Zcash-side fees are 97% of the cost.

### Findings

- The rail's house fee is now **20 bps** (`appFees[0].fee: 20`) in every quote today,
  while the page still says "Includes a 0.25% service fee". `APP_FEE_BPS` needs updating.
- After `SUCCESS` the tracker still labels the quoted amount "You would receive 14.384176
  USDC" and keeps the "The ZEC is on its way" lede; the rail's actual `amountOut`
  (14.400612) is available in the status body.
- `destinationChainTxHashes[].explorerUrl` is empty, so the tracker shows the Solana txid
  without a link.
- The oracle is the envelope's own view key, so it cannot show the outputs of the
  sweep; the transparent output and the fee arithmetic come from the public chain.

Video: `zenvelope-video/m5-live-solana.webm` / `.mp4` (outside the repo).
