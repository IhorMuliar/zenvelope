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

use zcash_client_backend::proto::service::{
    compact_tx_streamer_client::CompactTxStreamerClient, BlockId, BlockRange, ChainSpec, TxFilter,
};
use zcash_protocol::consensus::Network;
use zcash_protocol::TxId;

use crate::network_from_str;
use crate::scan::{
    notes_from_transaction, normalize_endpoint, parse_transaction, scan_compact_block, scan_range,
    total_zat, OpenResult, ReceivedNote, ViewKeys,
};

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
        set(&o, "amount_zat", &JsValue::from_str(&note.amount_zat.to_string()));
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
