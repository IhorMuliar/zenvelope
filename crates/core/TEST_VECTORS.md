# Test vectors

Fixed vectors for `zenvelope-core`. The web app asserts against these, so a change here
means either an intentional change to the derivation or a bug.

Generated 2026-09-20 with `zcash_keys` 0.16.1, `zcash_protocol` 0.10.6, `zcash_address`
0.13.0, `zip32` 0.2.1, `orchard` 0.15.5.

Regenerate:

```sh
cargo test -p zenvelope-core -- --ignored --nocapture print_test_vectors
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
