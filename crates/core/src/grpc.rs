//! gRPC-web transport and the `open_envelope` export.
//!
//! Browsers cannot speak gRPC: there is no way to control HTTP/2 frames from a page. The
//! gRPC-web profile exists for exactly that, and `tonic-web-wasm-client` implements it
//! over `fetch`, so the generated `CompactTxStreamer` client from `zcash_client_backend`
//! runs unchanged. The endpoint must therefore be a gRPC-web gateway
//! (`https://zjs.zec.rocks/mainnet`), not a plain gRPC lightwalletd.
//!
//! This module exists only on `wasm32`; everything it does with the data it fetches lives
//! in [`crate::scan`], which builds everywhere and is unit-tested natively.

use std::collections::BTreeSet;

use futures_util::StreamExt;
use js_sys::{Array, Function, Object, Reflect};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;

use orchard::circuit::OrchardCircuitVersion;
use zcash_client_backend::proto::service::{
    compact_tx_streamer_client::CompactTxStreamerClient, BlockId, BlockRange, ChainSpec, TxFilter,
};
use zcash_primitives::transaction::builder::cached_orchard_proving_key;
use zcash_protocol::consensus::Network;
use zcash_protocol::TxId;

use crate::network_from_str;
use crate::scan::{
    normalize_endpoint, notes_from_transaction, parse_transaction, scan_compact_block, scan_range,
    total_zat, OpenResult, ReceivedNote, ViewKeys,
};
use crate::sweep::{sweep, NoteRef, SweepOutcome, SweepRequest};

/// How often the progress callback fires, in blocks.
///
/// Every block would be one JS call per 75 s of chain history and would dominate a long
/// scan; 100 keeps a progress bar smooth without the callback becoming the workload.
const PROGRESS_EVERY: u32 = 100;

/// Opens an envelope: derive, sync, trial-decrypt, and report the notes received.
///
/// Returns a `Promise` so the browser's event loop keeps running while blocks stream in.
/// Rejects with a plain string, like every other export in this crate.
#[wasm_bindgen]
pub fn open_envelope(
    secret_b64url: String,
    birthday: Option<u32>,
    network: String,
    lightwalletd_url: String,
    on_progress: Option<Function>,
) -> js_sys::Promise {
    future_to_promise(async move {
        match open_envelope_inner(
            &secret_b64url,
            birthday,
            &network,
            &lightwalletd_url,
            on_progress.as_ref(),
        )
        .await
        {
            Ok(result) => Ok(to_js(&result)),
            Err(e) => Err(JsValue::from_str(&e)),
        }
    })
}

async fn open_envelope_inner(
    secret_b64url: &str,
    birthday: Option<u32>,
    network: &str,
    lightwalletd_url: &str,
    on_progress: Option<&Function>,
) -> Result<OpenResult, String> {
    let network: Network = network_from_str(network)?;
    let endpoint = normalize_endpoint(lightwalletd_url)?;
    let keys = ViewKeys::from_secret(secret_b64url, network)?;

    let transport = tonic_web_wasm_client::Client::new(endpoint);
    let mut client = CompactTxStreamerClient::new(transport);

    let tip = client
        .get_latest_block(ChainSpec {})
        .await
        .map_err(|e| format!("GetLatestBlock failed: {}", e.message()))?
        .into_inner()
        .height;
    let tip_height = u32::try_from(tip).map_err(|_| format!("chain tip height {tip} is absurd"))?;

    let (start, birthday_defaulted, scanned_blocks) = scan_range(birthday, tip_height);

    // Pass 1: stream compact blocks and trial-decrypt. `pool_types` is left empty, which
    // asks the server for the legacy shielded set (Sapling, Orchard and Ironwood) rather
    // than a pruned one, so nothing is filtered out before we see it.
    let mut stream = client
        .get_block_range(BlockRange {
            start: Some(BlockId {
                height: u64::from(start),
                hash: Vec::new(),
            }),
            end: Some(BlockId {
                height: u64::from(tip_height),
                hash: Vec::new(),
            }),
            pool_types: Vec::new(),
        })
        .await
        .map_err(|e| format!("GetBlockRange failed: {}", e.message()))?
        .into_inner();

    let mut hits: BTreeSet<(u32, TxId)> = BTreeSet::new();
    let mut scanned: u32 = 0;
    report(on_progress, 0, scanned_blocks);

    while let Some(block) = stream.next().await {
        let block = block.map_err(|e| format!("block stream failed: {}", e.message()))?;
        let height = u32::try_from(block.height)
            .map_err(|_| format!("block height {} is absurd", block.height))?;

        for txid in scan_compact_block(&block, &keys) {
            hits.insert((height, txid));
        }

        scanned += 1;
        if scanned % PROGRESS_EVERY == 0 {
            report(on_progress, scanned, scanned_blocks);
        }
    }
    report(on_progress, scanned, scanned_blocks);

    // Pass 2: fetch each hit in full. Compact blocks carry 52 bytes of ciphertext, enough
    // to recognise a note but not to read its memo, so the memo comes from here.
    let mut notes: Vec<ReceivedNote> = Vec::new();
    for (height, txid) in hits {
        let raw = client
            .get_transaction(TxFilter {
                block: None,
                index: 0,
                hash: txid.as_ref().to_vec(),
            })
            .await
            .map_err(|e| format!("GetTransaction({txid}) failed: {}", e.message()))?
            .into_inner();

        let tx = parse_transaction(&raw.data, height, network)?;
        notes.extend(notes_from_transaction(&tx, height, &keys, network));
    }

    let total = total_zat(&notes)?;
    Ok(OpenResult {
        notes,
        total_zat: total,
        tip_height,
        birthday: start,
        birthday_defaulted,
        scanned_blocks,
    })
}

/// Calls the progress callback, ignoring anything it throws.
///
/// A recipient's scan must not die because a progress bar did.
fn report(on_progress: Option<&Function>, scanned: u32, total: u32) {
    if let Some(f) = on_progress {
        let _ = f.call2(
            &JsValue::NULL,
            &JsValue::from_f64(f64::from(scanned)),
            &JsValue::from_f64(f64::from(total)),
        );
    }
}

/// Builds the plain JS object the export resolves with.
///
/// Amounts cross as decimal strings: a zatoshi total can exceed `Number.MAX_SAFE_INTEGER`
/// and no amount in this codebase is ever handed to an f64.
fn to_js(result: &OpenResult) -> JsValue {
    let notes = Array::new();
    for note in &result.notes {
        let o = Object::new();
        set(
            &o,
            "amount_zat",
            &JsValue::from_str(&note.amount_zat.to_string()),
        );
        set(
            &o,
            "memo",
            &match &note.memo {
                Some(m) => JsValue::from_str(m),
                None => JsValue::NULL,
            },
        );
        set(&o, "height", &JsValue::from_f64(f64::from(note.height)));
        set(&o, "txid", &JsValue::from_str(&note.txid));
        set(&o, "pool", &JsValue::from_str(note.pool));
        // M3 needs this to witness the exact action it is spending.
        set(
            &o,
            "action_index",
            &JsValue::from_f64(note.action_index as f64),
        );
        notes.push(&o);
    }

    let out = Object::new();
    set(&out, "found", &JsValue::from_bool(result.found()));
    set(&out, "notes", &notes);
    set(
        &out,
        "total_zat",
        &JsValue::from_str(&result.total_zat.to_string()),
    );
    set(
        &out,
        "tip_height",
        &JsValue::from_f64(f64::from(result.tip_height)),
    );
    set(
        &out,
        "birthday",
        &JsValue::from_f64(f64::from(result.birthday)),
    );
    set(
        &out,
        "birthday_defaulted",
        &JsValue::from_bool(result.birthday_defaulted),
    );
    set(
        &out,
        "scanned_blocks",
        &JsValue::from_f64(f64::from(result.scanned_blocks)),
    );
    out.into()
}

fn set(o: &Object, key: &str, value: &JsValue) {
    // Reflect::set on a freshly created plain object cannot fail.
    let _ = Reflect::set(o, &JsValue::from_str(key), value);
}

// ---------------------------------------------------------------------------
// M3: warming the proving key, and the sweep
// ---------------------------------------------------------------------------

/// Builds the Ironwood proving key now, and returns how many milliseconds it took.
///
/// # How the warm-up works
///
/// `zcash_primitives` builds its own Orchard/Ironwood proving key inside
/// `Builder::build`, caching it in a process-wide `OnceLock` keyed by circuit version
/// (`cached_orchard_proving_key`, which that crate exports as a `pub fn`). Without a
/// warm-up the recipient pays for that key build — about 35 s of single-threaded wasm —
/// inside the same call that proves, with no way to tell the two apart on screen.
///
/// Three ways to force it early were considered:
///
/// 1. **A `[patch.crates-io]` fork of `zcash_primitives`** adding an entry point that
///    touches the `OnceLock`. Rejected: it forks a consensus-critical crate to reach
///    something that is already public.
/// 2. **Building a throwaway bundle** so `build` populates the cache as a side effect.
///    Rejected: it costs a whole proof (about 52 s) on top of the key build, and needs a
///    fabricated note and anchor.
/// 3. **Calling `cached_orchard_proving_key` directly.** Taken. It is `pub`, it is the
///    very `OnceLock` the real build path reads, and it costs the key build and nothing
///    else. The circuit version is pinned to `PostNu6_3`, the version every Ironwood
///    bundle proves against.
///
/// A second call returns almost instantly, because the key is already there.
#[wasm_bindgen]
pub fn warm_proving_key() -> js_sys::Promise {
    future_to_promise(async move {
        let started = js_sys::Date::now();
        let key = cached_orchard_proving_key(OrchardCircuitVersion::PostNu6_3);
        // Touch the key so nothing can optimise the call away.
        let _ = core::ptr::from_ref(key);
        Ok(JsValue::from_f64(js_sys::Date::now() - started))
    })
}

/// Sweeps an envelope's Ironwood note to a destination, plus the flat Zenvelope fee.
///
/// `note` is `{ txid, height, action_index }`, exactly as `open_envelope` reports it. The
/// note is re-derived from the secret rather than trusted: the funding transaction is
/// fetched and the action decrypted here.
///
/// `on_stage(stage, detail)` fires with `"witness"`, `"keys"`, `"proving"`, `"broadcast"`
/// and `"done"`, in that order. When `broadcast` is false the transaction is built and
/// proved but never sent, and `raw_tx_hex` comes back for inspection.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn sweep_envelope(
    secret_b64url: String,
    network: String,
    lightwalletd_url: String,
    note: JsValue,
    destination: String,
    fee_address: String,
    fee_zat: String,
    memo: Option<String>,
    broadcast: bool,
    on_stage: Option<Function>,
) -> js_sys::Promise {
    future_to_promise(async move {
        match sweep_envelope_inner(
            secret_b64url,
            &network,
            &lightwalletd_url,
            &note,
            destination,
            fee_address,
            &fee_zat,
            memo,
            broadcast,
            on_stage.as_ref(),
        )
        .await
        {
            Ok(outcome) => Ok(outcome_to_js(&outcome)),
            Err(e) => Err(JsValue::from_str(&e)),
        }
    })
}

#[allow(clippy::too_many_arguments)]
async fn sweep_envelope_inner(
    secret_b64url: String,
    network: &str,
    lightwalletd_url: &str,
    note: &JsValue,
    destination: String,
    fee_address: String,
    fee_zat: &str,
    memo: Option<String>,
    broadcast: bool,
    on_stage: Option<&Function>,
) -> Result<SweepOutcome, String> {
    let network = network_from_str(network)?;
    let endpoint = normalize_endpoint(lightwalletd_url)?;

    let request = SweepRequest {
        secret_b64url,
        network,
        note: note_ref_from_js(note)?,
        destination,
        fee_address,
        fee_zat: parse_zat(fee_zat)?,
        memo,
        broadcast,
    };

    let transport = tonic_web_wasm_client::Client::new(endpoint);
    let mut client = CompactTxStreamerClient::new(transport)
        // A mainnet block carrying a full Ironwood bundle can exceed tonic's 4 MiB
        // default decoding limit, and so can a GetTransaction response.
        .max_decoding_message_size(64 * 1024 * 1024);

    let mut report = |stage: &str, detail: &str| {
        if let Some(f) = on_stage {
            // A progress callback must never be able to fail a sweep.
            let _ = f.call2(
                &JsValue::NULL,
                &JsValue::from_str(stage),
                &JsValue::from_str(detail),
            );
        }
    };

    sweep(&mut client, &request, &mut report).await
}

/// Reads `{ txid, height, action_index }` off a plain JS object.
fn note_ref_from_js(note: &JsValue) -> Result<NoteRef, String> {
    let get = |key: &str| {
        Reflect::get(note, &JsValue::from_str(key))
            .map_err(|_| format!("note.{key} could not be read"))
    };

    let txid = get("txid")?
        .as_string()
        .ok_or("note.txid must be a hex string")?;

    let height = get("height")?
        .as_f64()
        .ok_or("note.height must be a number")?;
    if !height.is_finite() || height.fract() != 0.0 || height < 1.0 || height > f64::from(u32::MAX)
    {
        return Err(format!("note.height {height} is not a block height"));
    }

    let action_index = get("action_index")?
        .as_f64()
        .ok_or("note.action_index must be a number")?;
    if !action_index.is_finite() || action_index.fract() != 0.0 || action_index < 0.0 {
        return Err(format!(
            "note.action_index {action_index} is not an action index"
        ));
    }

    Ok(NoteRef {
        txid,
        height: height as u32,
        action_index: action_index as usize,
    })
}

/// Parses a zatoshi amount that crossed the boundary as a decimal string.
fn parse_zat(value: &str) -> Result<u64, String> {
    let s = value.trim();
    if s.is_empty() {
        return Err("fee_zat is empty".to_string());
    }
    if !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!(
            "fee_zat {value:?} is not a whole number of zatoshi"
        ));
    }
    s.parse::<u64>()
        .map_err(|_| format!("fee_zat {value:?} is out of range"))
}

/// Builds the plain JS object the sweep resolves with. Amounts cross as decimal strings.
fn outcome_to_js(outcome: &SweepOutcome) -> JsValue {
    let o = Object::new();
    set(&o, "txid", &JsValue::from_str(&outcome.txid));
    set(
        &o,
        "raw_tx_hex",
        &match &outcome.raw_tx_hex {
            Some(hex) => JsValue::from_str(hex),
            None => JsValue::NULL,
        },
    );
    set(
        &o,
        "amount_to_destination_zat",
        &JsValue::from_str(&outcome.amount_to_destination_zat.to_string()),
    );
    set(
        &o,
        "fee_zat",
        &JsValue::from_str(&outcome.fee_zat.to_string()),
    );
    set(
        &o,
        "network_fee_zat",
        &JsValue::from_str(&outcome.network_fee_zat.to_string()),
    );
    set(
        &o,
        "anchor_height",
        &JsValue::from_f64(f64::from(outcome.anchor_height)),
    );
    set(&o, "broadcast", &JsValue::from_bool(outcome.broadcast));
    set(
        &o,
        "error_code",
        &match outcome.error_code {
            Some(code) => JsValue::from_f64(f64::from(code)),
            None => JsValue::NULL,
        },
    );
    set(
        &o,
        "error_message",
        &match &outcome.error_message {
            Some(m) => JsValue::from_str(m),
            None => JsValue::NULL,
        },
    );
    o.into()
}
