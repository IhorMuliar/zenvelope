//! Zenvelope key-derivation core.
//!
//! A Zenvelope link carries a 32-byte secret in the URL fragment. This crate turns that
//! secret into the shielded Zcash address the sender pays, and builds the ZIP-321 payment
//! URI that drives the sender's wallet.
//!
//! The derived address carries exactly one receiver, the Orchard receiver (unified
//! typecode `0x03`). After NU6.3 ("Ironwood") that receiver takes Ironwood notes; ZIP 258
//! forbids new value entering the Orchard pool. No Sapling receiver, no transparent
//! receiver, so nothing in the flow can land outside the shielded pool.
//!
//! Everything here is pure computation over bytes. Nothing reaches the network, and the
//! secret never leaves the caller's memory.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use wasm_bindgen::prelude::*;

use zcash_address::{
    unified::{Container, Receiver},
    ConversionError, TryFromAddress, ZcashAddress,
};
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedSpendingKey};
use zcash_protocol::consensus::{Network, NetworkType};
use zcash_protocol::value::{Zatoshis, COIN, MAX_MONEY};
use zip32::AccountId;
use zip321::{Payment, TransactionRequest};

/// Length of a link secret in bytes. Also the ZIP-32 seed length.
pub const SECRET_BYTES: usize = 32;

/// Length of a link secret once base64url-encoded without padding.
pub const SECRET_B64_LEN: usize = 43;

/// The separator between the secret and the birthday height in a link fragment.
const FRAGMENT_SEP: char = '.';

// ---------------------------------------------------------------------------
// Pure Rust core. Every wasm export below is a thin wrapper over these.
// ---------------------------------------------------------------------------

/// The result of deriving an envelope address from a link secret.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Derived {
    /// The unified address the sender pays, Orchard receiver only.
    pub address: String,
    /// The unified full viewing key, used to find the note when the link is opened.
    pub ufvk: String,
    /// The diversifier index the address was found at.
    pub diversifier_index: u128,
}

/// A parsed link fragment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fragment {
    /// The base64url secret, exactly as it appeared.
    pub secret: String,
    /// The block height at creation, if the fragment carried one.
    pub birthday: Option<u32>,
}

/// Maps the two network names accepted on the JS boundary onto consensus parameters.
pub fn network_from_str(name: &str) -> Result<Network, String> {
    match name {
        "main" => Ok(Network::MainNetwork),
        "test" => Ok(Network::TestNetwork),
        other => Err(format!(
            "unknown network {other:?}: expected \"main\" or \"test\""
        )),
    }
}

/// Decodes a link secret from base64url without padding into its 32 raw bytes.
pub fn decode_secret(secret_b64url: &str) -> Result<[u8; SECRET_BYTES], String> {
    if secret_b64url.len() != SECRET_B64_LEN {
        return Err(format!(
            "secret must be {SECRET_B64_LEN} base64url characters, got {}",
            secret_b64url.len()
        ));
    }
    let raw = URL_SAFE_NO_PAD
        .decode(secret_b64url.as_bytes())
        .map_err(|e| format!("secret is not valid unpadded base64url: {e}"))?;
    <[u8; SECRET_BYTES]>::try_from(raw.as_slice()).map_err(|_| {
        format!(
            "secret must decode to {SECRET_BYTES} bytes, got {}",
            raw.len()
        )
    })
}

/// Encodes 32 raw secret bytes as base64url without padding.
pub fn encode_secret(secret: &[u8; SECRET_BYTES]) -> String {
    URL_SAFE_NO_PAD.encode(secret)
}

/// Derives the envelope address and viewing key from a link secret.
///
/// The 32-byte secret is used directly as the ZIP-32 seed. The account is always
/// [`AccountId::ZERO`]: one envelope, one secret, one account.
pub fn derive_from_secret(secret_b64url: &str, network: Network) -> Result<Derived, String> {
    let seed = decode_secret(secret_b64url)?;

    let usk = UnifiedSpendingKey::from_seed(&network, &seed, AccountId::ZERO)
        .map_err(|e| format!("could not derive spending key from secret: {e:?}"))?;
    let ufvk = usk.to_unified_full_viewing_key();

    let (address, diversifier_index) = ufvk
        .default_address(UnifiedAddressRequest::ORCHARD)
        .map_err(|e| format!("could not derive an Orchard-only address: {e:?}"))?;

    Ok(Derived {
        address: address.encode(&network),
        ufvk: ufvk.encode(&network),
        diversifier_index: u128::from(diversifier_index),
    })
}

/// Generates a fresh 32-byte link secret from the platform CSPRNG.
///
/// In the browser this is `crypto.getRandomValues` by way of `getrandom`.
pub fn generate_secret_bytes() -> Result<[u8; SECRET_BYTES], String> {
    let mut buf = [0u8; SECRET_BYTES];
    getrandom::fill(&mut buf).map_err(|e| format!("CSPRNG unavailable: {e}"))?;
    Ok(buf)
}

/// Parses a link fragment: `<secret>` or `<secret>.<birthday>`.
///
/// A leading `#` is accepted so callers can pass `location.hash` unchanged.
pub fn parse_fragment(fragment: &str) -> Result<Fragment, String> {
    let body = fragment.strip_prefix('#').unwrap_or(fragment);
    if body.is_empty() {
        return Err("fragment is empty".to_string());
    }

    let (secret, birthday) = match body.split_once(FRAGMENT_SEP) {
        Some((secret, height)) => {
            if height.is_empty() {
                return Err("fragment has a separator but no birthday height".to_string());
            }
            if !height.bytes().all(|b| b.is_ascii_digit()) {
                return Err(format!(
                    "birthday height {height:?} is not a decimal number"
                ));
            }
            let parsed = height
                .parse::<u32>()
                .map_err(|_| format!("birthday height {height:?} is out of range"))?;
            (secret, Some(parsed))
        }
        None => (body, None),
    };

    // Validate the secret rather than hand back something that cannot derive.
    decode_secret(secret)?;

    Ok(Fragment {
        secret: secret.to_string(),
        birthday,
    })
}

/// Builds a link fragment from a secret and an optional birthday height.
///
/// The returned string has no leading `#`; the caller decides where it goes.
pub fn build_fragment(secret_b64url: &str, birthday: Option<u32>) -> Result<String, String> {
    decode_secret(secret_b64url)?;
    Ok(match birthday {
        Some(height) => format!("{secret_b64url}{FRAGMENT_SEP}{height}"),
        None => secret_b64url.to_string(),
    })
}

/// Renders a zatoshi amount as a ZIP-321 decimal ZEC string: at most 8 decimal places,
/// no trailing zeros, no trailing decimal point.
pub fn zat_to_zec_string(zat: u64) -> Result<String, String> {
    let zat = checked_zatoshis(zat)?;
    let coins = u64::from(zat) / COIN;
    let fraction = u64::from(zat) % COIN;
    Ok(if fraction == 0 {
        format!("{coins}")
    } else {
        format!("{coins}.{fraction:0>8}")
            .trim_end_matches('0')
            .to_string()
    })
}

/// Parses a decimal ZEC string into zatoshi. Rejects anything finer than 1 zatoshi, so no
/// value is ever silently rounded away.
pub fn zec_string_to_zat(zec: &str) -> Result<u64, String> {
    let s = zec.trim();
    if s.is_empty() {
        return Err("amount is empty".to_string());
    }
    let s = s.strip_prefix('+').unwrap_or(s);
    if s.starts_with('-') {
        return Err("amount must not be negative".to_string());
    }

    let (whole, fraction) = match s.split_once('.') {
        Some((w, f)) => (w, f),
        None => (s, ""),
    };
    if whole.is_empty() && fraction.is_empty() {
        return Err(format!("{zec:?} is not a decimal amount"));
    }
    if !whole.bytes().all(|b| b.is_ascii_digit()) || !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("{zec:?} is not a decimal amount"));
    }
    if fraction.len() > 8 {
        return Err(format!(
            "amount {zec:?} has {} decimal places; ZEC has 8",
            fraction.len()
        ));
    }

    let coins = if whole.is_empty() {
        0u64
    } else {
        whole
            .parse::<u64>()
            .map_err(|_| format!("amount {zec:?} is out of range"))?
    };
    let mut padded = fraction.to_string();
    while padded.len() < 8 {
        padded.push('0');
    }
    let zats = padded
        .parse::<u64>()
        .map_err(|_| format!("amount {zec:?} is out of range"))?;

    let total = coins
        .checked_mul(COIN)
        .and_then(|c| c.checked_add(zats))
        .ok_or_else(|| format!("amount {zec:?} is out of range"))?;
    checked_zatoshis(total)?;
    Ok(total)
}

/// Builds the single-output ZIP-321 URI the sender's wallet consumes.
///
/// One output only. The amount is the envelope amount plus the flat fee, already summed
/// in zatoshi by the caller, so no float ever touches the money.
pub fn payment_uri(
    address: &str,
    amount_zat: u64,
    message: Option<&str>,
) -> Result<String, String> {
    let amount = checked_zatoshis(amount_zat)?;
    if amount.is_zero() {
        return Err("amount must be greater than zero".to_string());
    }

    let recipient = ZcashAddress::try_from_encoded(address)
        .map_err(|e| format!("{address:?} is not a Zcash address: {e}"))?;

    let payment = Payment::new(
        recipient,
        Some(amount),
        None,
        None,
        message.map(str::to_string),
        vec![],
    )
    .map_err(|e| format!("could not build the payment output: {e:?}"))?;

    let request = TransactionRequest::new(vec![payment])
        .map_err(|e| format!("could not build the ZIP-321 request: {e:?}"))?;

    Ok(request.to_uri())
}

/// Decodes a unified address and confirms it carries exactly one receiver, Orchard.
///
/// This is the invariant M2 and M3 rest on: an envelope address that could also receive
/// into Sapling or a transparent output would put funds somewhere the open flow cannot
/// reach and would leak the payment on a public chain.
pub fn is_orchard_only(address: &str) -> Result<bool, String> {
    let (_, receivers) = decode_receivers(address)?;
    Ok(matches!(receivers.as_slice(), [Receiver::Orchard(_)]))
}

/// Decodes a unified address into its network and its receivers, in encoded order.
pub fn decode_receivers(address: &str) -> Result<(NetworkType, Vec<Receiver>), String> {
    let parsed = ZcashAddress::try_from_encoded(address)
        .map_err(|e| format!("{address:?} is not a Zcash address: {e}"))?;
    let Unified(net, receivers) = parsed
        .convert::<Unified>()
        .map_err(|e: ConversionError<String>| format!("{address:?} is not unified: {e}"))?;
    Ok((net, receivers))
}

/// Accepts only unified addresses when converting out of a [`ZcashAddress`].
struct Unified(NetworkType, Vec<Receiver>);

impl TryFromAddress for Unified {
    type Error = String;

    fn try_from_unified(
        net: NetworkType,
        data: zcash_address::unified::Address,
    ) -> Result<Self, ConversionError<Self::Error>> {
        Ok(Unified(net, data.items()))
    }
}

/// Rejects amounts outside the range a Zcash output can carry.
fn checked_zatoshis(zat: u64) -> Result<Zatoshis, String> {
    Zatoshis::from_u64(zat).map_err(|_| {
        format!("amount {zat} zatoshi is out of range; the maximum is {MAX_MONEY} zatoshi")
    })
}

// ---------------------------------------------------------------------------
// wasm-bindgen surface. Errors cross the boundary as thrown strings.
// ---------------------------------------------------------------------------

fn throw(message: impl AsRef<str>) -> JsValue {
    JsValue::from_str(message.as_ref())
}

/// The JS-visible result of [`derive`].
#[wasm_bindgen(getter_with_clone)]
pub struct DerivedAddress {
    pub address: String,
    pub ufvk: String,
    pub diversifier_index: f64,
}

/// The JS-visible result of [`parse_fragment`](parse_fragment_js).
#[wasm_bindgen(getter_with_clone)]
pub struct ParsedFragment {
    pub secret: String,
    pub birthday: Option<u32>,
}

/// Derives the envelope address and viewing key from a link secret.
#[wasm_bindgen(js_name = derive)]
pub fn derive_js(secret_b64url: &str, network: &str) -> Result<DerivedAddress, JsValue> {
    let network = network_from_str(network).map_err(throw)?;
    let derived = derive_from_secret(secret_b64url, network).map_err(throw)?;

    // A diversifier index is up to 88 bits wide. Anything past the exact integer range of a
    // JS number would be handed over wrong, so say so instead.
    if derived.diversifier_index > (1u128 << 53) {
        return Err(throw(
            "diversifier index is too large to represent as a JS number",
        ));
    }

    Ok(DerivedAddress {
        address: derived.address,
        ufvk: derived.ufvk,
        diversifier_index: derived.diversifier_index as f64,
    })
}

/// Generates a fresh link secret, base64url without padding.
#[wasm_bindgen(js_name = generate_secret)]
pub fn generate_secret_js() -> Result<String, JsValue> {
    let bytes = generate_secret_bytes().map_err(throw)?;
    Ok(encode_secret(&bytes))
}

/// Parses a link fragment into its secret and optional birthday height.
#[wasm_bindgen(js_name = parse_fragment)]
pub fn parse_fragment_js(fragment: &str) -> Result<ParsedFragment, JsValue> {
    let parsed = parse_fragment(fragment).map_err(throw)?;
    Ok(ParsedFragment {
        secret: parsed.secret,
        birthday: parsed.birthday,
    })
}

/// Builds a link fragment from a secret and an optional birthday height.
#[wasm_bindgen(js_name = build_fragment)]
pub fn build_fragment_js(secret: &str, birthday: Option<u32>) -> Result<String, JsValue> {
    build_fragment(secret, birthday).map_err(throw)
}

/// Builds the single-output ZIP-321 URI the sender's wallet consumes.
///
/// `amount_zat` accepts a BigInt, a decimal string, or a safe-integer number.
#[wasm_bindgen(js_name = payment_uri)]
pub fn payment_uri_js(
    address: &str,
    amount_zat: &JsValue,
    message: Option<String>,
) -> Result<String, JsValue> {
    let amount = js_to_u64(amount_zat).map_err(throw)?;
    payment_uri(address, amount, message.as_deref()).map_err(throw)
}

/// Renders a zatoshi amount as a decimal ZEC string.
#[wasm_bindgen(js_name = zat_to_zec_string)]
pub fn zat_to_zec_string_js(zat: &JsValue) -> Result<String, JsValue> {
    let zat = js_to_u64(zat).map_err(throw)?;
    zat_to_zec_string(zat).map_err(throw)
}

/// Parses a decimal ZEC string into zatoshi, returned as a BigInt.
#[wasm_bindgen(js_name = zec_string_to_zat)]
pub fn zec_string_to_zat_js(zec: &str) -> Result<js_sys::BigInt, JsValue> {
    let zat = zec_string_to_zat(zec).map_err(throw)?;
    Ok(js_sys::BigInt::from(zat))
}

/// Confirms a unified address carries exactly one receiver, Orchard.
#[wasm_bindgen(js_name = is_orchard_only)]
pub fn is_orchard_only_js(address: &str) -> Result<bool, JsValue> {
    is_orchard_only(address).map_err(throw)
}

/// Coerces a BigInt, decimal string, or safe-integer number into a `u64`.
fn js_to_u64(value: &JsValue) -> Result<u64, String> {
    if let Some(s) = value.as_string() {
        return parse_u64_decimal(s.trim());
    }
    if let Some(f) = value.as_f64() {
        if !f.is_finite() || f.fract() != 0.0 {
            return Err(format!("{f} is not a whole number of zatoshi"));
        }
        if f < 0.0 {
            return Err("amount must not be negative".to_string());
        }
        if f > 9_007_199_254_740_991.0 {
            return Err(
                "amount exceeds the exact integer range of a JS number; pass a BigInt or a string"
                    .to_string(),
            );
        }
        return Ok(f as u64);
    }
    // `JsValue::unchecked_ref` is only sound behind this check; the `TryFrom` impl for
    // BigInt is the blanket one and does not actually verify the type.
    if !value.is_bigint() {
        return Err("amount must be a BigInt, a decimal string, or a number".to_string());
    }
    let bigint: &js_sys::BigInt = value.unchecked_ref();
    let rendered = bigint
        .to_string(10)
        .map_err(|_| "amount is out of range for a decimal rendering".to_string())?;
    parse_u64_decimal(&String::from(rendered))
}

fn parse_u64_decimal(s: &str) -> Result<u64, String> {
    if s.is_empty() {
        return Err("amount is empty".to_string());
    }
    if s.starts_with('-') {
        return Err("amount must not be negative".to_string());
    }
    if !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("{s:?} is not a whole number of zatoshi"));
    }
    s.parse::<u64>()
        .map_err(|_| format!("amount {s:?} is out of range for a u64"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// The fixed test vector: bytes 0x01..=0x20.
    fn vector_secret() -> String {
        let bytes: [u8; SECRET_BYTES] = core::array::from_fn(|i| (i + 1) as u8);
        encode_secret(&bytes)
    }

    #[test]
    fn vector_secret_is_43_chars() {
        let secret = vector_secret();
        assert_eq!(secret.len(), SECRET_B64_LEN);
        assert_eq!(
            decode_secret(&secret).unwrap(),
            core::array::from_fn::<u8, SECRET_BYTES, _>(|i| (i + 1) as u8)
        );
    }

    #[test]
    fn derivation_is_deterministic() {
        let secret = vector_secret();
        let a = derive_from_secret(&secret, Network::MainNetwork).unwrap();
        let b = derive_from_secret(&secret, Network::MainNetwork).unwrap();
        assert_eq!(a, b);
        assert!(a.address.starts_with("u1"), "got {}", a.address);
        assert!(a.ufvk.starts_with("uview1"), "got {}", a.ufvk);
    }

    #[test]
    fn networks_derive_different_encodings() {
        let secret = vector_secret();
        let main = derive_from_secret(&secret, Network::MainNetwork).unwrap();
        let test = derive_from_secret(&secret, Network::TestNetwork).unwrap();
        assert!(test.address.starts_with("utest1"), "got {}", test.address);
        assert!(test.ufvk.starts_with("uviewtest1"), "got {}", test.ufvk);
        assert_ne!(main.address, test.address);
    }

    #[test]
    fn different_secrets_derive_different_addresses() {
        let mut bytes: [u8; SECRET_BYTES] = core::array::from_fn(|i| (i + 1) as u8);
        let a = derive_from_secret(&encode_secret(&bytes), Network::MainNetwork).unwrap();
        bytes[31] ^= 0x01;
        let b = derive_from_secret(&encode_secret(&bytes), Network::MainNetwork).unwrap();
        assert_ne!(a.address, b.address);
        assert_ne!(a.ufvk, b.ufvk);
    }

    #[test]
    fn address_has_exactly_one_orchard_receiver() {
        for (network, expected) in [
            (Network::MainNetwork, NetworkType::Main),
            (Network::TestNetwork, NetworkType::Test),
        ] {
            let derived = derive_from_secret(&vector_secret(), network).unwrap();
            let (net, receivers) = decode_receivers(&derived.address).unwrap();
            assert_eq!(net, expected);
            assert_eq!(receivers.len(), 1, "receivers: {receivers:?}");
            assert!(matches!(receivers[0], Receiver::Orchard(_)));
            assert!(is_orchard_only(&derived.address).unwrap());
        }
    }

    #[test]
    fn generated_secrets_derive_and_differ() {
        let a = encode_secret(&generate_secret_bytes().unwrap());
        let b = encode_secret(&generate_secret_bytes().unwrap());
        assert_ne!(a, b);
        assert_eq!(a.len(), SECRET_B64_LEN);
        derive_from_secret(&a, Network::MainNetwork).unwrap();
    }

    #[test]
    fn bad_secrets_are_rejected() {
        assert!(decode_secret("").is_err());
        assert!(decode_secret("short").is_err());
        // Correct length, but base64 standard alphabet rather than url-safe.
        assert!(decode_secret(&"+".repeat(SECRET_B64_LEN)).is_err());
        // Correct length, but padded base64 of only 30 bytes.
        assert!(decode_secret(&"A".repeat(SECRET_B64_LEN + 1)).is_err());
    }

    #[test]
    fn fragment_round_trip() {
        let secret = vector_secret();

        let without = build_fragment(&secret, None).unwrap();
        assert_eq!(without, secret);
        assert_eq!(
            parse_fragment(&without).unwrap(),
            Fragment {
                secret: secret.clone(),
                birthday: None
            }
        );

        let with = build_fragment(&secret, Some(3_490_400)).unwrap();
        assert_eq!(with, format!("{secret}.3490400"));
        assert_eq!(
            parse_fragment(&with).unwrap(),
            Fragment {
                secret: secret.clone(),
                birthday: Some(3_490_400)
            }
        );

        // A leading '#' is tolerated so location.hash can be passed straight through.
        assert_eq!(parse_fragment(&format!("#{with}")).unwrap().secret, secret);
        assert_eq!(
            parse_fragment(&format!("#{with}")).unwrap().birthday,
            Some(3_490_400)
        );
    }

    #[test]
    fn fragment_birthday_zero_round_trips() {
        let secret = vector_secret();
        let frag = build_fragment(&secret, Some(0)).unwrap();
        assert_eq!(frag, format!("{secret}.0"));
        assert_eq!(parse_fragment(&frag).unwrap().birthday, Some(0));
    }

    #[test]
    fn bad_fragments_are_rejected() {
        let secret = vector_secret();
        assert!(parse_fragment("").is_err());
        assert!(parse_fragment("#").is_err());
        assert!(parse_fragment(&format!("{secret}.")).is_err());
        assert!(parse_fragment(&format!("{secret}.abc")).is_err());
        assert!(parse_fragment(&format!("{secret}.-1")).is_err());
        assert!(parse_fragment(&format!("{secret}.99999999999")).is_err());
        assert!(parse_fragment(&format!("{secret}.1.2")).is_err());
        assert!(parse_fragment("notasecret.100").is_err());
        assert!(build_fragment("notasecret", None).is_err());
    }

    #[test]
    fn zec_formatting_edge_cases() {
        assert_eq!(zat_to_zec_string(0).unwrap(), "0");
        assert_eq!(zat_to_zec_string(1).unwrap(), "0.00000001");
        assert_eq!(zat_to_zec_string(10_000).unwrap(), "0.0001");
        assert_eq!(zat_to_zec_string(100_000_000).unwrap(), "1");
        assert_eq!(zat_to_zec_string(1_234_567_891).unwrap(), "12.34567891");
        // Trailing zeros are trimmed, and a whole number keeps no decimal point.
        assert_eq!(zat_to_zec_string(150_000_000).unwrap(), "1.5");
        assert_eq!(zat_to_zec_string(1_000_000_000).unwrap(), "10");
        assert_eq!(zat_to_zec_string(123_400_000).unwrap(), "1.234");
        assert_eq!(zat_to_zec_string(100_000_010).unwrap(), "1.0000001");
        assert_eq!(zat_to_zec_string(MAX_MONEY).unwrap(), "21000000");
    }

    #[test]
    fn zec_parsing_edge_cases() {
        assert_eq!(zec_string_to_zat("0").unwrap(), 0);
        assert_eq!(zec_string_to_zat("0.0001").unwrap(), 10_000);
        assert_eq!(zec_string_to_zat("1").unwrap(), 100_000_000);
        assert_eq!(zec_string_to_zat("12.34567891").unwrap(), 1_234_567_891);
        assert_eq!(zec_string_to_zat("1.50000000").unwrap(), 150_000_000);
        assert_eq!(zec_string_to_zat(".5").unwrap(), 50_000_000);
        assert_eq!(zec_string_to_zat("1.").unwrap(), 100_000_000);
        assert_eq!(zec_string_to_zat("  1.5  ").unwrap(), 150_000_000);
        assert_eq!(zec_string_to_zat("21000000").unwrap(), MAX_MONEY);
    }

    #[test]
    fn zec_parsing_rejects_bad_input() {
        assert!(zec_string_to_zat("").is_err());
        assert!(zec_string_to_zat("-1").is_err());
        assert!(
            zec_string_to_zat("1.234567891").is_err(),
            "9 decimal places"
        );
        assert!(zec_string_to_zat("1e8").is_err());
        assert!(zec_string_to_zat("abc").is_err());
        assert!(zec_string_to_zat(".").is_err());
        assert!(zec_string_to_zat("21000001").is_err(), "above MAX_MONEY");
        assert!(
            zec_string_to_zat("18446744073709551616").is_err(),
            "u64 overflow"
        );
    }

    #[test]
    fn zec_round_trip_is_lossless() {
        for zat in [
            0u64,
            1,
            10_000,
            100_000_000,
            1_234_567_891,
            150_000_000,
            MAX_MONEY,
        ] {
            let rendered = zat_to_zec_string(zat).unwrap();
            assert_eq!(zec_string_to_zat(&rendered).unwrap(), zat, "{rendered}");
        }
    }

    #[test]
    fn amount_overflow_is_rejected() {
        assert!(zat_to_zec_string(MAX_MONEY + 1).is_err());
        assert!(zat_to_zec_string(u64::MAX).is_err());

        let address = derive_from_secret(&vector_secret(), Network::MainNetwork)
            .unwrap()
            .address;
        assert!(payment_uri(&address, MAX_MONEY + 1, None).is_err());
        assert!(payment_uri(&address, u64::MAX, None).is_err());
        assert!(payment_uri(&address, 0, None).is_err());

        // The flat fee riding on top of the envelope amount must never wrap.
        let envelope = MAX_MONEY;
        let fee = 100_000u64;
        assert!(envelope.checked_add(fee).is_some());
        assert!(payment_uri(&address, envelope + fee, None).is_err());
    }

    #[test]
    fn payment_uri_shape() {
        let address = derive_from_secret(&vector_secret(), Network::MainNetwork)
            .unwrap()
            .address;

        let uri = payment_uri(&address, 10_000, None).unwrap();
        assert_eq!(uri, format!("zcash:{address}?amount=0.0001"));

        let uri = payment_uri(&address, 100_000_000, None).unwrap();
        assert_eq!(uri, format!("zcash:{address}?amount=1"));

        let uri = payment_uri(&address, 1_234_567_891, None).unwrap();
        assert_eq!(uri, format!("zcash:{address}?amount=12.34567891"));

        // Trailing zeros never appear.
        let uri = payment_uri(&address, 150_000_000, None).unwrap();
        assert_eq!(uri, format!("zcash:{address}?amount=1.5"));
    }

    #[test]
    fn payment_uri_message_is_percent_encoded() {
        let address = derive_from_secret(&vector_secret(), Network::MainNetwork)
            .unwrap()
            .address;
        let uri = payment_uri(&address, 10_000, Some("Happy birthday & thanks!")).unwrap();
        // Space and '&' must be escaped or the URI would split into extra parameters.
        // '!' is a qchar in ZIP-321 and is left as-is.
        assert_eq!(
            uri,
            format!("zcash:{address}?amount=0.0001&message=Happy%20birthday%20%26%20thanks!")
        );
        assert!(!uri.contains(' '));
        assert_eq!(uri.matches('&').count(), 1, "{uri}");
    }

    #[test]
    fn payment_uri_has_a_single_output() {
        let address = derive_from_secret(&vector_secret(), Network::MainNetwork)
            .unwrap()
            .address;
        let uri = payment_uri(&address, 10_000, Some("one output only")).unwrap();
        // Indexed parameters (amount.1=, address.1=) mean more than one output.
        assert!(!uri.contains("address="), "{uri}");
        assert!(!uri.contains("amount.1="), "{uri}");
        assert_eq!(uri.matches("amount=").count(), 1, "{uri}");

        let parsed = TransactionRequest::from_uri(&uri).unwrap();
        assert_eq!(parsed.payments().len(), 1);
    }

    #[test]
    fn payment_uri_rejects_bad_addresses() {
        assert!(payment_uri("not-an-address", 10_000, None).is_err());
        assert!(payment_uri("", 10_000, None).is_err());
    }

    #[test]
    fn payment_uri_works_on_testnet() {
        let address = derive_from_secret(&vector_secret(), Network::TestNetwork)
            .unwrap()
            .address;
        let uri = payment_uri(&address, 10_000, None).unwrap();
        assert!(uri.starts_with("zcash:utest1"), "{uri}");
    }

    #[test]
    fn network_names() {
        assert_eq!(network_from_str("main").unwrap(), Network::MainNetwork);
        assert_eq!(network_from_str("test").unwrap(), Network::TestNetwork);
        assert!(network_from_str("mainnet").is_err());
        assert!(network_from_str("").is_err());
    }

    #[test]
    fn diversifier_index_is_zero_for_orchard_only() {
        // Orchard has no invalid diversifiers, so the default address is always index 0.
        for network in [Network::MainNetwork, Network::TestNetwork] {
            let derived = derive_from_secret(&vector_secret(), network).unwrap();
            assert_eq!(derived.diversifier_index, 0);
        }
    }

    /// Prints the fixed vectors so TEST_VECTORS.md can be regenerated:
    /// `cargo test -p zenvelope-core -- --ignored --nocapture print_test_vectors`
    #[test]
    #[ignore]
    fn print_test_vectors() {
        let secret = vector_secret();
        println!("secret\t{secret}");
        for (label, network) in [
            ("main", Network::MainNetwork),
            ("test", Network::TestNetwork),
        ] {
            let d = derive_from_secret(&secret, network).unwrap();
            println!("{label}.address\t{}", d.address);
            println!("{label}.ufvk\t{}", d.ufvk);
            println!("{label}.diversifier_index\t{}", d.diversifier_index);
            println!(
                "{label}.uri\t{}",
                payment_uri(&d.address, 10_000_000, Some("Zenvelope test vector")).unwrap()
            );
        }
    }
}
