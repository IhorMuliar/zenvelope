//! M3 against mainnet, natively: witness the real M1 note, build the sweep, prove it,
//! and parse the result back. Never broadcasts.
//!
//! This is the same [`zenvelope_core::sweep::sweep`] the browser runs, driven over plain
//! gRPC instead of gRPC-web. Proving the sequence natively is what makes it safe to point
//! a browser at real money.
//!
//! # Running it
//!
//! Ignored by default, because it needs a funded envelope's link secret, which is money.
//! The secret lives in the private, never-committed `M1-FUND.md` in the main checkout.
//!
//! ```sh
//! export ZENV_M1_FRAGMENT='<the fragment from M1-FUND.md>'
//! # from the private, gitignored M3-DEST.md:
//! export ZENV_M3_DEST_ADDRESS='u1…'
//! export ZENV_M3_FEE_ADDRESS='u1…'
//! cargo test -p zenvelope-core --release --test m3_sweep -- --ignored --nocapture
//! ```
//!
//! `--release` is not optional in practice: the halo2 proof takes minutes in a debug
//! build and seconds to a minute in a release one.
//!
//! # It does not broadcast
//!
//! `broadcast: false`. The transaction is built, proved, signed and parsed back, and then
//! thrown away. Broadcasting the real sweep is a separate step the owner triggers by
//! hand, once.

use std::time::Instant;

use tonic::transport::{Channel, ClientTlsConfig};
use zcash_client_backend::proto::service::compact_tx_streamer_client::CompactTxStreamerClient;
use zcash_primitives::transaction::{Transaction, TxVersion};
use zcash_protocol::consensus::{BlockHeight, BranchId, Network};

use zenvelope_core::spend::{network_fee_zat, plan_amounts};
use zenvelope_core::sweep::{sweep, NoteRef, SweepRequest};

/// Plain gRPC, for native clients only. A browser cannot use this endpoint: it has no
/// gRPC-web bridge and no CORS headers (see D3).
const SERVER: &str = "https://zec.rocks:443";

/// The real M1 envelope, funded from Zodl on mainnet on 2026-09-20.
const M1_TXID: &str = "281e9f7bffa5bffc8ee1287cc6e245cc59eee302727ea9d93c7f8e5a99341d43";
const M1_HEIGHT: u32 = 3_490_472;
const M1_VALUE_ZAT: u64 = 130_000;
/// Which of the transaction's two Ironwood actions is ours. Zodl paid the envelope and
/// took its own change in the same bundle; `locate_the_m1_note` below reports this, and
/// `open_envelope` reports it as `action_index` for any envelope.
const M1_ACTION_INDEX: usize = 1;

/// The flat Zenvelope fee this sweep collects.
const FEE_ZAT: u64 = 30_000;

/// The M1 envelope's one note, as `open_envelope` reports it.
fn m1_note() -> NoteRef {
    NoteRef {
        txid: M1_TXID.to_string(),
        height: M1_HEIGHT,
        action_index: M1_ACTION_INDEX,
    }
}

/// Reads a required environment variable, explaining where it comes from.
fn env(name: &str, where_from: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set; it comes from {where_from}"))
}

/// Takes the secret out of a link fragment: `<secret>` or `<secret>.<birthday>`.
fn secret_from_fragment(fragment: &str) -> String {
    zenvelope_core::parse_fragment(fragment.trim())
        .expect("ZENV_M1_FRAGMENT is not a Zenvelope link fragment")
        .secret
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "spends real mainnet key material; needs ZENV_M1_FRAGMENT"]
async fn sweeps_the_m1_note_on_mainnet_without_broadcasting() {
    let secret = secret_from_fragment(&env(
        "ZENV_M1_FRAGMENT",
        "the private M1-FUND.md in the main checkout",
    ));
    let destination = env("ZENV_M3_DEST_ADDRESS", "the private M3-DEST.md");
    let fee_address = env("ZENV_M3_FEE_ADDRESS", "the private M3-DEST.md");

    // The envelope's own address must come back out of the secret, or we are about to
    // witness someone else's note.
    let derived = zenvelope_core::derive_from_secret(&secret, Network::MainNetwork)
        .expect("the fragment derives an envelope address");
    println!("envelope address  {}", derived.address);
    println!("destination       {destination}");
    println!("fee address       {fee_address}");

    let channel = Channel::from_static(SERVER)
        .tls_config(ClientTlsConfig::new().with_webpki_roots())
        .expect("TLS config")
        .connect()
        .await
        .expect("connecting to zec.rocks");
    let mut client = CompactTxStreamerClient::new(channel)
        // Mainnet blocks and transactions both exceed tonic's 4 MiB default.
        .max_decoding_message_size(64 * 1024 * 1024);

    let request = SweepRequest {
        secret_b64url: secret,
        network: Network::MainNetwork,
        // One note, in the array form every caller now uses. The M1 envelope holds
        // exactly one; an envelope with more would name them all here.
        notes: vec![m1_note()],
        destination: destination.clone(),
        fee_address: fee_address.clone(),
        fee_zat: FEE_ZAT,
        memo: Some("Zenvelope M3".to_string()),
        broadcast: false,
    };

    // The fee is decided before any network work, so it can be checked against the
    // arithmetic the unit tests pin down.
    let outputs = request
        .plan_outputs(Network::MainNetwork)
        .expect("both addresses resolve");
    assert_eq!(outputs.len(), 2, "destination plus the flat fee output");
    assert_eq!(network_fee_zat(1, &outputs), 10_000, "two Ironwood actions");
    let expected =
        plan_amounts(M1_VALUE_ZAT, FEE_ZAT, 1, &outputs).expect("the note covers the sweep");
    assert_eq!(expected.amount_to_destination_zat, 90_000);

    // Stage timings. Each stage's clock stops when the next one starts.
    let started = Instant::now();
    let mut marks: Vec<(String, f64)> = Vec::new();
    let mut last_stage: Option<String> = None;
    let mut last_at = started;
    let mut stages_seen: Vec<String> = Vec::new();

    let mut on_stage = |stage: &str, detail: &str| {
        let now = Instant::now();
        if stages_seen.last().map(String::as_str) != Some(stage) {
            if let Some(previous) = last_stage.take() {
                marks.push((previous, (now - last_at).as_secs_f64()));
                last_at = now;
            }
            stages_seen.push(stage.to_string());
            last_stage = Some(stage.to_string());
        }
        println!(
            "[{:7.2}s] {stage}: {detail}",
            started.elapsed().as_secs_f64()
        );
    };

    let outcome = sweep(&mut client, &request, &mut on_stage)
        .await
        .expect("the sweep builds and proves");
    if let Some(previous) = last_stage.take() {
        marks.push((previous, last_at.elapsed().as_secs_f64()));
    }

    // --- the stages fired, in order -----------------------------------------
    assert_eq!(
        stages_seen,
        vec!["witness", "keys", "proving", "broadcast", "done"],
        "stages must fire in the documented order"
    );

    // --- the amounts -------------------------------------------------------
    assert_eq!(outcome.amount_to_destination_zat, 90_000);
    assert_eq!(outcome.fee_zat, FEE_ZAT);
    assert_eq!(outcome.network_fee_zat, 10_000);
    assert_eq!(
        outcome.amount_to_destination_zat + outcome.fee_zat + outcome.network_fee_zat,
        M1_VALUE_ZAT,
        "every zatoshi of the note is accounted for"
    );

    // --- nothing was sent --------------------------------------------------
    assert!(!outcome.broadcast, "this test must never broadcast");
    assert_eq!(outcome.error_code, None);
    assert_eq!(outcome.error_message, None);

    // --- the transaction parses back ---------------------------------------
    let raw_hex = outcome.raw_tx_hex.as_ref().expect("a raw transaction");
    let raw = hex::decode(raw_hex).expect("the raw transaction is hex");

    let branch = BranchId::for_height(
        &Network::MainNetwork,
        BlockHeight::from_u32(outcome.anchor_height),
    );
    let parsed = Transaction::read(&raw[..], branch).expect("the raw transaction parses back");

    assert_eq!(parsed.version(), TxVersion::V6, "Ironwood needs a V6 tx");
    assert_eq!(
        parsed.txid().to_string(),
        outcome.txid,
        "the parsed txid must be the one reported"
    );

    let bundle = parsed
        .ironwood_bundle()
        .expect("the sweep has an Ironwood bundle");
    assert_eq!(
        bundle.actions().len(),
        2,
        "one spend and two outputs share two Ironwood actions"
    );
    assert_eq!(
        raw.len(),
        9_166,
        "the one-note sweep is the same 9,166 bytes it was before sweeps could spend \
         several notes; a change here is a change to the transaction itself"
    );
    assert!(
        parsed.sapling_bundle().is_none(),
        "no Sapling bundle, which is what makes NoSaplingProver sound"
    );
    assert!(
        parsed.orchard_bundle().is_none(),
        "ZIP 258 forbids new value entering the Orchard pool"
    );
    assert!(
        parsed.transparent_bundle().is_none(),
        "both outputs are shielded"
    );

    println!();
    println!("ANCHOR   height {}", outcome.anchor_height);
    println!("TXID     {}", outcome.txid);
    println!("RAW TX   {} bytes", raw.len());
    for (stage, seconds) in &marks {
        println!("STAGE    {stage:<10} {seconds:.2} s");
    }
    println!("TOTAL    {:.2} s", started.elapsed().as_secs_f64());
    println!();
    println!("NOT BROADCAST. Broadcasting is a separate step, triggered by hand.");
}

/// Prints which Ironwood action of the M1 transaction belongs to the envelope.
///
/// A diagnostic, not an assertion: run it when a sweep says the action does not decrypt.
///
/// ```sh
/// cargo test -p zenvelope-core --test m3_sweep -- --ignored --nocapture locate_the_m1_note
/// ```
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs ZENV_M1_FRAGMENT"]
async fn locate_the_m1_note() {
    use zcash_client_backend::proto::service::TxFilter;
    use zenvelope_core::sweep::txid_to_protocol_bytes;

    let secret = secret_from_fragment(&env("ZENV_M1_FRAGMENT", "the private M1-FUND.md"));
    let ufvk = zenvelope_core::ufvk_from_secret(&secret, Network::MainNetwork).unwrap();
    let fvk = ufvk.orchard().unwrap();

    let channel = Channel::from_static(SERVER)
        .tls_config(ClientTlsConfig::new().with_webpki_roots())
        .unwrap()
        .connect()
        .await
        .unwrap();
    let mut client = CompactTxStreamerClient::new(channel).max_decoding_message_size(64 << 20);

    let raw = client
        .get_transaction(TxFilter {
            block: None,
            index: 0,
            hash: txid_to_protocol_bytes(M1_TXID).unwrap(),
        })
        .await
        .unwrap()
        .into_inner();

    let tx = zenvelope_core::scan::parse_transaction(&raw.data, M1_HEIGHT, Network::MainNetwork)
        .unwrap();
    println!("version {:?}", tx.version());
    println!(
        "orchard actions  {}",
        tx.orchard_bundle().map_or(0, |b| b.actions().len())
    );
    let bundle = tx.ironwood_bundle().expect("an Ironwood bundle");
    println!("ironwood actions {}", bundle.actions().len());

    for idx in 0..bundle.actions().len() {
        for scope in [
            orchard::keys::Scope::External,
            orchard::keys::Scope::Internal,
        ] {
            if let Some((note, _, _)) = bundle.decrypt_output_with_key(idx, &fvk.to_ivk(scope)) {
                println!(
                    "action {idx} decrypts with {scope:?}: {} zatoshi, note version {:?}",
                    note.value().inner(),
                    note.version()
                );
            }
        }
    }
}

/// Mints the destination wallet and the fee envelope this test sweeps into.
///
/// Run once; the output goes into the private, gitignored `M3-DEST.md` in the main
/// checkout and never into the repository. Everything it prints is key material.
///
/// ```sh
/// cargo test -p zenvelope-core --test m3_sweep -- --ignored --nocapture mint_m3_destination
/// ```
#[test]
#[ignore = "generates key material; run by hand into the private M3-DEST.md"]
fn mint_m3_destination() {
    let birthday = M1_HEIGHT;

    let wallet = zenvelope_core::spend::new_wallet(Network::MainNetwork, birthday)
        .expect("a fresh 24-word wallet");
    println!("== destination wallet ==");
    println!("mnemonic  {}", wallet.mnemonic);
    println!("address   {}", wallet.address);
    println!("ufvk      {}", wallet.ufvk);
    println!("birthday  {}", wallet.birthday);

    // The fee output goes to an ordinary Zenvelope envelope address: a fresh link secret,
    // derived exactly as a link is. Zenvelope can sweep it later with its own open flow.
    let fee_secret = zenvelope_core::encode_secret(
        &zenvelope_core::generate_secret_bytes().expect("the CSPRNG works"),
    );
    let fee = zenvelope_core::derive_from_secret(&fee_secret, Network::MainNetwork)
        .expect("the fee secret derives");
    println!();
    println!("== fee envelope ==");
    println!("secret    {fee_secret}");
    println!("address   {}", fee.address);
    println!("ufvk      {}", fee.ufvk);
    println!("birthday  {birthday}");
}

/// The fee arithmetic the live test rests on, without a network or a secret.
#[test]
fn the_m1_sweep_arithmetic_is_fixed() {
    // 130,000 − 10,000 network − 30,000 flat = 90,000 to the destination.
    assert_eq!(M1_VALUE_ZAT - 10_000 - FEE_ZAT, 90_000);
}

/// The M1 note cannot stand in for a second note: two spends of one note are two copies
/// of one nullifier, and no node accepts that.
///
/// So the real chain path is proved with the one note in a one-element array (above),
/// the multi-note bookkeeping is proved against synthetic trees in
/// `crates/core/src/spend.rs`, and the only thing left to prove here is that naming the
/// same note twice is refused — before a single byte is fetched, which is why this test
/// needs neither the network nor the secret.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_same_note_twice_is_refused_before_any_network_work() {
    // A client pointed at an endpoint that does not exist: if the guard did not fire
    // first, this test would fail on a connection error instead of on the message below.
    let channel = Channel::from_static("http://127.0.0.1:1").connect_lazy();
    let mut client = CompactTxStreamerClient::new(channel);

    let request = SweepRequest {
        secret_b64url: zenvelope_core::encode_secret(&[7u8; 32]),
        network: Network::MainNetwork,
        notes: vec![m1_note(), m1_note()],
        destination: String::new(),
        fee_address: String::new(),
        fee_zat: 0,
        memo: None,
        broadcast: false,
    };

    let err = sweep(&mut client, &request, &mut |_, _| {})
        .await
        .expect_err("the same note twice must be refused");
    assert!(err.contains("same note"), "{err}");
    assert!(err.contains("cannot spend it twice"), "{err}");
}

/// An envelope with several notes pays for `max(spends, outputs)` actions.
///
/// The live sweep above is a one-note envelope, so this is where the multi-note fee
/// arithmetic is pinned down against the same helpers the sweep uses.
#[test]
fn several_notes_are_charged_by_action_count() {
    use zenvelope_core::spend::{ironwood_action_count, resolve_output};

    // Two ordinary unified destinations: the envelope's own address stands in for both.
    let address = zenvelope_core::derive_from_secret(
        &zenvelope_core::encode_secret(&[3u8; 32]),
        Network::MainNetwork,
    )
    .expect("a derived envelope address")
    .address;
    let outputs = vec![
        resolve_output(&address, Network::MainNetwork).expect("an Ironwood output"),
        resolve_output(&address, Network::MainNetwork).expect("an Ironwood output"),
    ];

    // One note and two notes cost the same: the spends ride in the actions the outputs
    // had already paid for. The third note is the first one to cost anything.
    assert_eq!(ironwood_action_count(1, &outputs), 2);
    assert_eq!(network_fee_zat(1, &outputs), 10_000);
    assert_eq!(network_fee_zat(2, &outputs), 10_000);
    assert_eq!(network_fee_zat(3, &outputs), 15_000);

    // Three 50,000-zatoshi notes: 150,000 in, 15,000 network, 30,000 flat, 105,000 out.
    let plan = plan_amounts(150_000, FEE_ZAT, 3, &outputs).expect("the notes cover the sweep");
    assert_eq!(plan.network_fee_zat, 15_000);
    assert_eq!(plan.amount_to_destination_zat, 105_000);
    assert_eq!(
        plan.amount_to_destination_zat + plan.fee_zat + plan.network_fee_zat,
        150_000
    );
}
