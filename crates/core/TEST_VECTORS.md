# Test vectors

Fixed vectors for `zenvelope-core`. The web app asserts against these, so a change here
means either an intentional change to the derivation or a bug.

Generated 2026-09-20 with `zcash_keys` 0.16.1, `zcash_protocol` 0.10.6, `zcash_address`
0.13.0, `zip32` 0.2.1, `orchard` 0.15.5.

Regenerate:

```sh
cargo test -p zenvelope-core -- --ignored --nocapture print_test_vectors
cargo test -p zenvelope-core -- --ignored --nocapture print_m3_test_vectors
```

## Secret

The 32 bytes `0x01 0x02 … 0x20`, base64url without padding.

| | |
| --- | --- |
| bytes | `0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20` |
| secret | `AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA` |
| length | 43 characters |

```js
const SECRET = Buffer.from(
  Array.from({ length: 32 }, (_, i) => i + 1),
).toString("base64url");
// "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA"
```

## Mainnet

`derive(SECRET, "main")`

| Field | Value |
| --- | --- |
| `address` | `u1nxx35rnvjqzuz03fcg4yur2atgm3j2yl4xsl6l93u5nxw8mxw0t5gxqlqfxruppsy7akehfj5h63j7mqx6z6uzvl0n7f3v08kszpwv4f` |
| `ufvk` | `uview1xcdx66vhn75khyxkcstyeyjfg3kr59ynykc5fwnnf3pmcqtt9aszantses97lgd3gdl9a0c7ys5zhmt9hqnky49r09yhtcmm42lk8qdcy5r254xljsfnwhqmukygfxnl766l2x4svpudnvxc90gngvyc6fglx6l8j3gdhks73sxq3m6mj0gvm9csfw2tf` |
| `diversifier_index` | `0` |
| receivers | exactly one, Orchard (typecode `0x03`) |

## Testnet

`derive(SECRET, "test")`

| Field | Value |
| --- | --- |
| `address` | `utest1ythf7gkem8m6hna5mvvjntgvwc2rujaza72dec08azu45xdl60es6jp8h2g2693dx7afwzrz5lp9tfk43exx9ce3s38tt958pq5cxp0c` |
| `ufvk` | `uviewtest1cxc75xyyvjs0ac9nvjzuu7c46aj07e3v6uh8cwhdlj9xrck5vljrkm4gl926xh5zceh3y66guf6sdkexey6980zk5r4ct6jmefdpcpj7vxfgv52g4squf3ju7e6gu963n6spvfdy9zhdpeqljwtdfejqaj9nscf02sw36z7zl9nev7z0fukjtyc5l00sd` |
| `diversifier_index` | `0` |
| receivers | exactly one, Orchard (typecode `0x03`) |

## Fragment

| Call | Result |
| --- | --- |
| `build_fragment(SECRET)` | `AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA` |
| `build_fragment(SECRET, 3490400)` | `AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA.3490400` |
| `parse_fragment("#AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA.3490400")` | `{ secret: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA", birthday: 3490400 }` |

## ZIP-321 URI

The third argument is the **memo**: the sender's text, carried as base64url of its UTF-8
bytes without padding, so the sending wallet writes it into the note. There is no
`message=` parameter — M2 proved on mainnet that a ZIP-321 message stays in the sending
wallet and never reaches the chain.

| | |
| --- | --- |
| memo text | `Zenvelope test vector` |
| UTF-8 bytes | 21 |
| `memo=` | `WmVudmVsb3BlIHRlc3QgdmVjdG9y` |

`payment_uri(<mainnet address>, 10000000n, "Zenvelope test vector")`

```
zcash:u1nxx35rnvjqzuz03fcg4yur2atgm3j2yl4xsl6l93u5nxw8mxw0t5gxqlqfxruppsy7akehfj5h63j7mqx6z6uzvl0n7f3v08kszpwv4f?amount=0.1&memo=WmVudmVsb3BlIHRlc3QgdmVjdG9y
```

`payment_uri(<testnet address>, 10000000n, "Zenvelope test vector")`

```
zcash:utest1ythf7gkem8m6hna5mvvjntgvwc2rujaza72dec08azu45xdl60es6jp8h2g2693dx7afwzrz5lp9tfk43exx9ce3s38tt958pq5cxp0c?amount=0.1&memo=WmVudmVsb3BlIHRlc3QgdmVjdG9y
```

`payment_uri(<address>, 10000000n, undefined)` omits the parameter entirely, and a memo
over 512 UTF-8 bytes is rejected.

## Amount formatting

`zat_to_zec_string` and its inverse `zec_string_to_zat`.

| zatoshi | ZEC string |
| --- | --- |
| `0` | `0` |
| `1` | `0.00000001` |
| `10000` | `0.0001` |
| `100000000` | `1` |
| `123400000` | `1.234` |
| `150000000` | `1.5` |
| `1000000000` | `10` |
| `1234567891` | `12.34567891` |
| `2100000000000000` | `21000000` |

Rejected: `2100000000000001` zatoshi and above (over `MAX_MONEY`), `0` as a payment
amount, and any ZEC string with more than 8 decimal places.

## M3: a fresh in-browser wallet

`new_wallet(network, birthday)` generates 24 English BIP-39 words and derives account 0
from `mnemonic.to_seed("")` — the full 64-byte seed with an **empty passphrase**, which is
what Zodl (formerly Zashi) and `zcash-devtool` do. That is the whole point of the choice:
these words can be typed into Zodl and the same account comes back.

The fixed vector is the all-zero-entropy mnemonic, so an import can be checked by hand
against the address below.

| | |
| --- | --- |
| entropy | 32 zero bytes |
| mnemonic | `abandon` × 23 then `art` |
| seed | `408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf705489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840` |
| account | 0 |
| receivers | Orchard **and** Sapling (no transparent) |

`new_wallet("main", …).address`

```
u1nvgt6yr35mhc9wdf4wckvl38476vqy96dx3cwkfdwy4jet9300l5v8l2yg27ql7w9qwm0lf8kncnj9nus4mgete06j3cu3mhrqvstg6swvdya6xgzwhh6a9xxdhxkavvvmztqeuaurjtqfk3dzetuzgnu0zjvmdpe8ehvj53sy6yhzxj
```

`new_wallet("main", …).ufvk`

```
uview1ul22wp00mjcm5zrh3drvv7df95knzlvku6fph4zhppfn7pvhu8mv56x75n0vzdkzm6n37w45med2mkr6g80x3rtws29wdk8sr55mmdw37gac26mjpp3ggt7e788k0qgkscqnqlpxjkepndz4a538zxw8gh2t3thn3kmu72wsnexe2rywaw8navg3xpdkjaxnej758rxjg8j936pjpvq3ywx224z8w6nxwt2sqsly6w05zttvrtntren5e57mtuf49x8sptwrudlnfjuyuqyunf9cfyd59vg9fvn2juypyl35gpzyfqf3lxecw4dmxqk00x7wz45swe9pc8dq42n6dwryqtgyg5pe20wvsgjz3l22h06usz2anx2wylskzgh0m4cvrmckjy0yh
```

`new_wallet("test", …).address`

```
utest1dumh7z6x5xf4ay3wnkvc60uru4hu54y55u0t3xm78v2cqs5nk0zhsqspa4dqcpcj82hmtt049f30kx5z58yzxg3d7y3lpy69pg9vsdy7hdh2qfw8jj2u6vd46ztw7tzf88lydf8p3w7nre6zenfqeayq4e4njagajwvrmelywq76akhk
```

A wallet's `birthday` is carried through untouched; it is the height an import should
start scanning from, not something the derivation depends on.

## M3: destination matrix

`classify_address(address, network)` returns `{ kind, reason }`. A sweep pays the first
two and refuses the rest with a sentence the recipient can read.

| Address | `kind` | Swept to |
| --- | --- | --- |
| unified with an Orchard receiver (`u1…`) | `unified_orchard` | an Ironwood output |
| transparent (`t1…`, `t3…`) | `transparent` | a transparent output |
| unified without an Orchard receiver | `unified_no_orchard` | refused |
| Sapling (`zs1…`) | `sapling` | refused |
| anything else, or the wrong network | `invalid` | refused |

## M3: ZIP-317 fee

The sweep has exactly one Ironwood spend. Ironwood permits cross-address transfers, so a
spend and an output share an action and the count is `max(spends, outputs)`, padded to the
2-action minimum. ZIP-317's grace is 2 actions, so the first two are free of marginal fee.

| Outputs | Logical actions | Network fee |
| --- | --- | --- |
| 1 shielded (no flat fee) | 2 | `10000` |
| 2 shielded (destination + flat fee) | 2 | `10000` |
| 1 shielded + 1 transparent | 3 | `15000` |

`amount_to_destination = note − network fee − flat fee`, and a sweep that leaves nothing
to send is refused rather than built.
