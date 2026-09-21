# M5 verification — the Solana exit

**Date:** 2026-09-21
**Milestone:** M5, the optional Solana exit through NEAR Intents 1Click (DECISIONS D10, D14).
**Nothing was broadcast.** Every run took the `?dry=1` path, `sweep_envelope` was called
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
