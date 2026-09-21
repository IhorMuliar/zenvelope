//! The network half of M3: fetch, witness, prove, broadcast.
//!
//! Everything here is generic over the gRPC transport, so the browser (gRPC-web over
//! `fetch`, via `tonic-web-wasm-client`) and the native integration test (plain gRPC over
//! `tonic::transport::Channel`) run the *same* code against mainnet. That is the whole
//! point: the sequence that spends real money is exercised natively before a browser ever
//! runs it.
//!
//! # Anchor policy
//!
//! Zebra accepts a spend against any anchor that is a root of a finalized Ironwood tree
//! state, not just a recent one. That gives two valid strategies:
//!
//! - **Same-block anchor.** Witness the note in its own block and stop. One `GetTreeState`
//!   and one `GetBlock`, constant cost however old the envelope is. The anchor height is
//!   then public in the sense that it equals the note's block, which an observer who
//!   already knows the funding transaction learns nothing new from.
//! - **Recent anchor.** Keep rolling the witness forward to the chain tip. This is what
//!   an ordinary wallet does, and it hides the note's age from anyone reading the anchor.
//!   It costs one streamed block per block of distance.
//!
//! [`ANCHOR_WALK_CAP`] takes the middle: the anchor is `min(tip, newest note + cap)`, so
//! the walk is bounded however old the envelope is. A recipient opening a link minutes
//! after it was funded — the normal case — still gets the chain tip, because the tip is
//! the smaller of the two. An older envelope gets an anchor `cap` blocks past its newest
//! note instead of the tip, which is the privacy/latency trade-off written down in
//! DECISIONS.md D18 and in crates/core/README.md.
//!
//! # The `SendTransaction` trap
//!
//! `SendTransaction` answers a *rejected* transaction with gRPC status 0, OK, and puts the
//! rejection in `SendResponse.error_code` and `SendResponse.error_message`. A client that
//! only checks the gRPC status will report a rejected sweep as a successful one and tell
//! the recipient their money has moved when it has not. [`broadcast`] checks the field.

use futures_util::StreamExt;
use tonic::codegen::{Body, Bytes, StdError};

use zcash_client_backend::proto::service::{
    compact_tx_streamer_client::CompactTxStreamerClient, BlockId, BlockRange, ChainSpec,
    RawTransaction, TxFilter,
};
use zcash_protocol::consensus::Network;
use zcash_protocol::memo::MemoBytes;

use std::collections::BTreeMap;

use crate::scan::parse_transaction;
use crate::spend::{
    build_and_prove, ironwood_action_count, network_fee_zat, plan_amounts, resolve_output,
    spend_keys_from_secret, SweepOutput, SweepPlan, WitnessScan, WitnessTarget,
};
use crate::{memo_bytes, ufvk_from_secret};

/// The most blocks the witness replay ever walks past the newest note.
///
/// 24 blocks is about half an hour of mainnet at 75 s per block. The anchor is
/// `min(tip, newest note height + this)`, so the walk is bounded no matter how old the
/// envelope is, and the block stream the replay consumes is bounded with it.
///
/// **This is a privacy/latency trade-off, not a correctness one.** Zebra accepts a spend
/// against the root of any finalized Ironwood tree state, so an anchor 24 blocks past the
/// note is as consensus-valid as the tip — the M3 spike verified a same-block anchor
/// against mainnet, which is the extreme case of the same thing. The walk therefore
/// exists for one reason only: so the anchor does not pin the exact funding block. Any
/// distance past the note buys that, and every block of it is paid for in Sinsemilla
/// hashing — about 2 s for 24 blocks on a desktop and under 1 s on a recent phone, where
/// 120 blocks cost about 10 s (web/docs/PERF-2026-09-21.md §9 and §10). What the cap
/// costs is anonymity-set freshness: an observer reading the anchor learns the
/// transaction was built against a tree state no later than `note + 24`, which for an old
/// envelope is a narrower window than "somewhere at the tip". What it buys is a sweep
/// whose witness stage does not grow without bound as an envelope ages: before the cap, a
/// 777-block-old envelope replayed all 777 blocks, and a month-old one would replay
/// 35,000.
pub const ANCHOR_WALK_CAP: u32 = 24;

/// Wall-clock milliseconds, wherever this crate is compiled.
///
/// The browser is the only place the numbers are read, but `sweep` also runs natively in
/// `tests/m3_sweep.rs`, and `js_sys::Date::now()` has nothing to call there.
#[cfg(target_arch = "wasm32")]
fn now_ms() -> f64 {
    js_sys::Date::now()
}

#[cfg(not(target_arch = "wasm32"))]
fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1_000.0)
}

/// The stages a sweep reports, in the order they fire.
pub const STAGES: [&str; 5] = ["witness", "keys", "proving", "broadcast", "done"];

/// Which note in which transaction to sweep.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoteRef {
    /// The transaction id in the big-endian form block explorers display.
    pub txid: String,
    /// The height of the block it was mined in.
    pub height: u32,
    /// Index into that transaction's `ironwood_actions`.
    pub action_index: usize,
}

/// A sweep request, as it arrives from the JS boundary.
#[derive(Clone, Debug)]
pub struct SweepRequest {
    pub secret_b64url: String,
    pub network: Network,
    /// Every note the envelope holds. A sweep spends **all** of them, in one
    /// transaction: one `add_ironwood_spend` each, against one shared anchor.
    pub notes: Vec<NoteRef>,
    /// Where the recipient wants the money.
    pub destination: String,
    /// Where Zenvelope's flat fee goes. Ignored when `fee_zat` is zero.
    pub fee_address: String,
    pub fee_zat: u64,
    /// The memo on the destination output, if any.
    pub memo: Option<String>,
    /// When false, the transaction is built and proved but never sent.
    pub broadcast: bool,
}

/// What a sweep produced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SweepOutcome {
    pub txid: String,
    /// The serialized transaction, hex. Always present when it was not broadcast.
    pub raw_tx_hex: Option<String>,
    pub amount_to_destination_zat: u64,
    pub fee_zat: u64,
    pub network_fee_zat: u64,
    pub anchor_height: u32,
    pub broadcast: bool,
    /// `SendResponse.error_code`, which is 0 on acceptance and nonzero on rejection.
    pub error_code: Option<i32>,
    pub error_message: Option<String>,
    /// Which gateway served this sweep, as a host name. Filled in by the caller that
    /// chose it; empty in the native test, which is handed one channel and no choice.
    pub gateway: String,
}

/// Decodes a display (byte-reversed) txid into the protocol byte order the wire uses.
pub fn txid_to_protocol_bytes(display: &str) -> Result<Vec<u8>, String> {
    let mut bytes =
        hex::decode(display.trim()).map_err(|e| format!("txid {display:?} is not hex: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!(
            "txid {display:?} decodes to {} bytes, want 32",
            bytes.len()
        ));
    }
    bytes.reverse();
    Ok(bytes)
}

/// Picks the anchor height for an envelope, given the chain tip.
///
/// `note_height` is the **youngest** note's block: with several notes the anchor must be
/// at or after all of them, so the cap is measured from the newest one. See the module
/// docs. Returns the height whose Ironwood tree root becomes the anchor.
///
/// The rule is `min(tip, note_height + ANCHOR_WALK_CAP)`, with one floor: a tip at or
/// below the note's block means the note is in the newest block we know of, and its own
/// block is then the only anchor available. The walk never runs backwards.
pub fn anchor_height(note_height: u32, tip_height: u32) -> u32 {
    if tip_height <= note_height {
        return note_height;
    }
    tip_height.min(note_height.saturating_add(ANCHOR_WALK_CAP))
}

/// Runs a whole sweep: fetch the note, witness it, build and prove, and optionally send.
///
/// `known_tip` is the chain tip the caller already has. In the browser the gateway race
/// *is* a `GetLatestBlock`, so its answer is handed in here rather than asked for a
/// second time; `None` means nobody knows yet and this function asks. The tip decides
/// the anchor and the transaction's target height, and nothing else.
///
/// `on_stage` is called with `(stage, detail)` in the order given by [`STAGES`]. It is a
/// progress report and nothing more: whatever it does cannot fail the sweep.
pub async fn sweep<T>(
    client: &mut CompactTxStreamerClient<T>,
    request: &SweepRequest,
    known_tip: Option<u32>,
    on_stage: &mut dyn FnMut(&str, &str),
) -> Result<SweepOutcome, String>
where
    T: tonic::client::GrpcService<tonic::body::Body> + Clone,
    T::Error: Into<StdError>,
    T::ResponseBody: Body<Data = Bytes> + Send + 'static,
    <T::ResponseBody as Body>::Error: Into<StdError> + Send,
{
    let network = request.network;

    if request.notes.is_empty() {
        return Err("this sweep names no notes to spend".to_string());
    }

    // --- stage: witness ----------------------------------------------------
    on_stage(
        "witness",
        &format!(
            "finding the envelope's {} note{}",
            request.notes.len(),
            if request.notes.len() == 1 { "" } else { "s" }
        ),
    );

    // The same note twice would be the same nullifier twice, which no node accepts.
    // Catch it here rather than in a build error after the witness work.
    for (i, note) in request.notes.iter().enumerate() {
        if let Some(j) = request.notes[..i]
            .iter()
            .position(|other| other.txid == note.txid && other.action_index == note.action_index)
        {
            return Err(format!(
                "notes {j} and {i} are the same note ({}, action {}); a transaction \
                 cannot spend it twice",
                note.txid, note.action_index
            ));
        }
    }

    let txids: Vec<Vec<u8>> = request
        .notes
        .iter()
        .map(|n| txid_to_protocol_bytes(&n.txid))
        .collect::<Result<_, _>>()?;

    // The replay runs from the earliest note's block to the anchor, and every note is
    // witnessed as the replay passes its own commitment. Both bounds come out of the
    // request, so they are known before a single byte crosses the network — which is what
    // lets the frontier and the first block be fetched alongside everything else below.
    let first_height = request
        .notes
        .iter()
        .map(|n| n.height)
        .min()
        .expect("the request holds at least one note");
    let last_height = request
        .notes
        .iter()
        .map(|n| n.height)
        .max()
        .expect("the request holds at least one note");
    if first_height == 0 {
        return Err("a note cannot be in block 0".to_string());
    }

    // One transaction can hold more than one of the envelope's notes, so each distinct
    // funding transaction is fetched once.
    let mut distinct: Vec<(String, Vec<u8>)> = Vec::new();
    for (slot, note_ref) in request.notes.iter().enumerate() {
        if !distinct.iter().any(|(txid, _)| *txid == note_ref.txid) {
            distinct.push((note_ref.txid.clone(), txids[slot].clone()));
        }
    }

    // Everything the witness stage needs before the anchor walk is independent of
    // everything else it needs, so it all goes out at once rather than one round trip at
    // a time: the chain tip, each funding transaction, the frontier just before the
    // earliest note's block, and that block itself. On a gateway answering in 110 ms that
    // turns four or more serial trips into one.
    // The chain tip, which the caller usually already has: in the browser the gateway
    // race is itself a `GetLatestBlock`, and asking a second time bought nothing but a
    // round trip and one more call that could fail. Only a caller with no tip pays for
    // one here.
    let tip_call = {
        let mut client = client.clone();
        async move {
            if let Some(tip) = known_tip {
                return Ok::<_, String>((tip, 0.0));
            }
            let t = now_ms();
            let height = client
                .get_latest_block(ChainSpec {})
                .await
                .map_err(|e| format!("GetLatestBlock failed: {}", e.message()))?
                .into_inner()
                .height;
            let h = u32::try_from(height)
                .map_err(|_| format!("chain tip height {height} is absurd"))?;
            Ok::<_, String>((h, now_ms() - t))
        }
    };

    let tx_calls = futures_util::future::try_join_all(distinct.into_iter().map(
        |(display_txid, wire_txid)| {
            let mut client = client.clone();
            async move {
                let t = now_ms();
                let raw = client
                    .get_transaction(TxFilter {
                        block: None,
                        index: 0,
                        hash: wire_txid,
                    })
                    .await
                    .map_err(|e| format!("GetTransaction failed: {}", e.message()))?
                    .into_inner()
                    .data;
                Ok::<_, String>((display_txid, raw, now_ms() - t))
            }
        },
    ));

    let frontier_call = {
        let mut client = client.clone();
        async move {
            let t = now_ms();
            let tree = client
                .get_tree_state(BlockId {
                    height: u64::from(first_height - 1),
                    hash: Vec::new(),
                })
                .await
                .map_err(|e| format!("GetTreeState({}) failed: {}", first_height - 1, e.message()))?
                .into_inner()
                .ironwood_tree()
                .map_err(|e| format!("could not parse the Ironwood frontier: {e}"))?;
            Ok::<_, String>((tree, now_ms() - t))
        }
    };

    let first_block_call = {
        let mut client = client.clone();
        async move {
            let t = now_ms();
            let block = client
                .get_block(BlockId {
                    height: u64::from(first_height),
                    hash: Vec::new(),
                })
                .await
                .map(|r| r.into_inner())
                .map_err(|e| format!("GetBlock({first_height}) failed: {}", e.message()))?;
            Ok::<_, String>((block, now_ms() - t))
        }
    };

    let t_batch = now_ms();
    let ((tip_height, tip_ms), fetched_txs, (start_tree, frontier_ms), (first_block, block_ms)) =
        futures_util::future::try_join4(tip_call, tx_calls, frontier_call, first_block_call)
            .await?;
    let tx_ms = fetched_txs.iter().map(|(_, _, ms)| *ms).fold(0.0f64, f64::max);
    on_stage(
        "witness",
        &format!(
            "fetched the funding transaction, the frontier and the note's block in \
             {:.0} ms (tip {tip_ms:.0}, tx {tx_ms:.0}, frontier {frontier_ms:.0}, block \
             {block_ms:.0})",
            now_ms() - t_batch
        ),
    );

    let fetched: BTreeMap<String, Vec<u8>> =
        fetched_txs.into_iter().map(|(id, raw, _)| (id, raw)).collect();

    let ufvk = ufvk_from_secret(&request.secret_b64url, network)?;
    let fvk = ufvk
        .orchard()
        .ok_or("the link's viewing key carries no Orchard key")?;

    // Re-derive every note from the secret rather than trusting anything the caller says
    // about them: decrypt the named action of the funding transaction ourselves.
    let mut notes = Vec::with_capacity(request.notes.len());
    let mut total_value_zat: u64 = 0;

    for note_ref in request.notes.iter() {
        let raw = fetched
            .get(&note_ref.txid)
            .ok_or_else(|| format!("transaction {} was not fetched", note_ref.txid))?;

        let funding_tx = parse_transaction(raw, note_ref.height, network)?;
        let bundle = funding_tx
            .ironwood_bundle()
            .ok_or("that transaction has no Ironwood bundle")?;

        let idx = note_ref.action_index;
        let (note, _, _) = [
            orchard::keys::Scope::External,
            orchard::keys::Scope::Internal,
        ]
        .iter()
        .find_map(|scope| bundle.decrypt_output_with_key(idx, &fvk.to_ivk(*scope)))
        .ok_or_else(|| {
            format!(
                "Ironwood action {idx} of transaction {} does not decrypt with this \
                 link's viewing key",
                note_ref.txid
            )
        })?;

        total_value_zat = total_value_zat
            .checked_add(note.value().inner())
            .ok_or("the envelope's notes sum to more than u64 can hold")?;
        notes.push(note);
    }


    // Which notes each block holds, keyed by height so the replay can hand `append_block`
    // exactly the targets that block contains.
    let mut targets_by_height: BTreeMap<u32, Vec<WitnessTarget<'_>>> = BTreeMap::new();
    for (slot, note_ref) in request.notes.iter().enumerate() {
        targets_by_height
            .entry(note_ref.height)
            .or_default()
            .push(WitnessTarget {
                txid_protocol: &txids[slot],
                action_index: note_ref.action_index,
                slot,
            });
    }

    // Replay the Ironwood tree from the frontier just before the earliest note's block.
    // Both the frontier and that block were fetched above, alongside the chain tip.
    let mut scan = WitnessScan::new(start_tree, request.notes.len());

    // The root the replay reports at the end of each block that holds a note. Each one is
    // checked against the chain's own tree state below: if the replay is wrong it is
    // wrong at a note's block, and a proof built on it would be rejected.
    let mut roots_at_note_blocks: Vec<(u32, String)> = Vec::new();

    scan.append_block(
        &first_block,
        targets_by_height
            .get(&first_height)
            .map(Vec::as_slice)
            .unwrap_or(&[]),
    )?;
    roots_at_note_blocks.push((first_height, scan.tree_root_hex()));

    // The replay is sequential by nature and stays that way: an Ironwood frontier is
    // built by appending commitments in chain order, and every witness already taken
    // absorbs each later leaf, so there is no independent unit of work to hand a thread.
    // What is bounded instead is how much of it there is — [`ANCHOR_WALK_CAP`] — and how
    // the blocks arrive: one `GetBlockRange` stream for the whole range, consumed block
    // by block and handed to `append_block` by reference. Nothing here clones a block or
    // buffers the range.
    let anchor_at = anchor_height(last_height, tip_height);
    if anchor_at > first_height {
        let mut stream = client
            .get_block_range(BlockRange {
                start: Some(BlockId {
                    height: u64::from(first_height + 1),
                    hash: Vec::new(),
                }),
                end: Some(BlockId {
                    height: u64::from(anchor_at),
                    hash: Vec::new(),
                }),
                pool_types: Vec::new(),
            })
            .await
            .map_err(|e| format!("GetBlockRange failed: {}", e.message()))?
            .into_inner();

        let mut walked = 0u32;
        let mut waited_ms = 0.0f64;
        let mut appended_ms = 0.0f64;
        loop {
            let t_wait = now_ms();
            let Some(block) = stream.next().await else { break };
            let t_got = now_ms();
            waited_ms += t_got - t_wait;
            let block = block.map_err(|e| format!("block stream failed: {}", e.message()))?;
            let height = u32::try_from(block.height)
                .map_err(|_| format!("block height {} is absurd", block.height))?;
            let targets = targets_by_height
                .get(&height)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let t_append = now_ms();
            scan.append_block(&block, targets)?;
            appended_ms += now_ms() - t_append;
            if !targets.is_empty() {
                roots_at_note_blocks.push((height, scan.tree_root_hex()));
            }
            walked += 1;
            if walked.is_multiple_of(100) {
                on_stage(
                    "witness",
                    &format!("rolling the witnesses forward, {walked} blocks"),
                );
            }
        }
        on_stage(
            "witness",
            &format!(
                "replayed {walked} blocks: {:.0} ms waiting for them, {appended_ms:.0} ms \
                 hashing {} commitments into the witness",
                waited_ms,
                scan.appended()
            ),
        );
    }

    let missing = scan.missing();
    if !missing.is_empty() {
        let slot = missing[0];
        let note_ref = &request.notes[slot];
        return Err(format!(
            "block {} has no Ironwood action {} in transaction {}",
            note_ref.height, note_ref.action_index, note_ref.txid
        ));
    }

    // The ordering guard, once per note block: the replay must have seen the same
    // commitments, in the same order, as the chain did. Every one of these tree states,
    // and the anchor's, is an independent read of a block that is already mined, so they
    // are asked for together — one round trip instead of one per note block plus one.
    // Not one of them is dropped: each answer is compared exactly as before, and a
    // failure to fetch any of them fails the sweep.
    let mut heights: Vec<u32> = roots_at_note_blocks.iter().map(|(h, _)| *h).collect();
    heights.push(anchor_at);
    let t_roots = now_ms();
    let served = futures_util::future::try_join_all(heights.iter().map(|height| {
        let mut client = client.clone();
        let height = *height;
        async move { tree_state_root(&mut client, height).await }
    }))
    .await?;

    on_stage(
        "witness",
        &format!(
            "checked {} root(s) against the chain, {:.0} ms",
            served.len(),
            now_ms() - t_roots
        ),
    );

    for ((height, replayed), server) in roots_at_note_blocks.iter().zip(served.iter()) {
        if replayed != server {
            return Err(format!(
                "the replayed Ironwood root at block {height} is {replayed} but the \
                 server reports {server}"
            ));
        }
    }

    let anchor_root = served
        .last()
        .cloned()
        .expect("the anchor height was pushed onto the list");
    let positions = scan.positions();
    let appended = scan.appended();
    let (merkle_paths, anchor) = scan.finish(&anchor_root)?;
    let positions_note = positions
        .iter()
        .map(|p| p.map_or_else(|| "?".to_string(), |p| p.to_string()))
        .collect::<Vec<_>>()
        .join(", ");
    on_stage(
        "witness",
        &format!(
            "{} note(s) at position {positions_note}, anchor {anchor_root} at height \
             {anchor_at} ({appended} commitments replayed)",
            merkle_paths.len()
        ),
    );

    // --- stage: keys -------------------------------------------------------
    on_stage("keys", "deriving the envelope's spending key");
    let keys = spend_keys_from_secret(&request.secret_b64url, network)?;

    // --- stage: proving ----------------------------------------------------
    let outputs = request.plan_outputs(network)?;
    let action_count = ironwood_action_count(notes.len(), &outputs);
    let amounts = plan_amounts(total_value_zat, request.fee_zat, notes.len(), &outputs)?;

    let memo = match request.memo.as_deref().filter(|m| !m.is_empty()) {
        Some(text) => memo_bytes(text)?,
        None => MemoBytes::empty(),
    };

    let mut with_amounts: Vec<(SweepOutput, u64, MemoBytes)> = Vec::with_capacity(outputs.len());
    let mut rest = outputs.into_iter();
    let destination = rest.next().ok_or("a sweep needs a destination output")?;
    with_amounts.push((destination, amounts.amount_to_destination_zat, memo));
    for fee_output in rest {
        with_amounts.push((fee_output, amounts.fee_zat, MemoBytes::empty()));
    }

    on_stage(
        "proving",
        &format!(
            "proving a {}-action Ironwood bundle spending {} note(s), {} zatoshi to the \
             destination",
            action_count,
            notes.len(),
            amounts.amount_to_destination_zat
        ),
    );

    // The target height is the next block: the transaction is meant for a block that does
    // not exist yet, and its expiry is counted from there.
    let (tx, raw_tx) = build_and_prove(SweepPlan {
        network,
        target_height: tip_height + 1,
        anchor,
        keys,
        notes: notes.into_iter().zip(merkle_paths).collect(),
        outputs: with_amounts,
    })?;

    let txid = tx.txid().to_string();
    let raw_hex = hex::encode(&raw_tx);

    let mut outcome = SweepOutcome {
        txid: txid.clone(),
        raw_tx_hex: Some(raw_hex),
        amount_to_destination_zat: amounts.amount_to_destination_zat,
        fee_zat: amounts.fee_zat,
        network_fee_zat: amounts.network_fee_zat,
        anchor_height: anchor_at,
        broadcast: false,
        error_code: None,
        error_message: None,
        // Filled in by whoever chose the gateway; `sweep` itself is handed a transport
        // and is not told what is behind it.
        gateway: String::new(),
    };

    // --- stage: broadcast --------------------------------------------------
    if request.broadcast {
        on_stage(
            "broadcast",
            &format!("sending {} bytes to the network", raw_tx.len()),
        );
        let (code, message) = broadcast(client, raw_tx).await?;
        outcome.broadcast = true;
        outcome.error_code = Some(code);
        outcome.error_message = if message.is_empty() {
            None
        } else {
            Some(message.clone())
        };
        if code != 0 {
            return Err(format!(
                "the network rejected the sweep (error_code {code}): {message}"
            ));
        }
    } else {
        on_stage("broadcast", "skipped: broadcast was not requested");
    }

    on_stage("done", &txid);
    Ok(outcome)
}

/// Sends a raw transaction and returns `SendResponse`'s own verdict.
///
/// A gRPC `Ok` here means the *call* succeeded, not that the transaction was accepted.
/// See the module docs: the acceptance verdict is `error_code`, and it is the caller's
/// job to look at it.
pub async fn broadcast<T>(
    client: &mut CompactTxStreamerClient<T>,
    raw_tx: Vec<u8>,
) -> Result<(i32, String), String>
where
    T: tonic::client::GrpcService<tonic::body::Body>,
    T::Error: Into<StdError>,
    T::ResponseBody: Body<Data = Bytes> + Send + 'static,
    <T::ResponseBody as Body>::Error: Into<StdError> + Send,
{
    let response = client
        .send_transaction(RawTransaction {
            data: raw_tx,
            height: 0,
        })
        .await
        .map_err(|e| format!("SendTransaction failed: {}", e.message()))?
        .into_inner();
    Ok((response.error_code, response.error_message))
}

/// The Ironwood tree root the server reports at a height, as hex.
async fn tree_state_root<T>(
    client: &mut CompactTxStreamerClient<T>,
    height: u32,
) -> Result<String, String>
where
    T: tonic::client::GrpcService<tonic::body::Body>,
    T::Error: Into<StdError>,
    T::ResponseBody: Body<Data = Bytes> + Send + 'static,
    <T::ResponseBody as Body>::Error: Into<StdError> + Send,
{
    let tree = client
        .get_tree_state(BlockId {
            height: u64::from(height),
            hash: Vec::new(),
        })
        .await
        .map_err(|e| format!("GetTreeState({height}) failed: {}", e.message()))?
        .into_inner()
        .ironwood_tree()
        .map_err(|e| format!("could not parse the Ironwood tree at {height}: {e}"))?;
    Ok(crate::spend::node_hex(&tree.root()))
}

impl SweepRequest {
    /// Resolves the destination and, when there is a flat fee, the fee address.
    ///
    /// The destination is always first. A zero flat fee means one output and no fee
    /// address is looked at, so a caller that is not charging a fee need not supply one.
    pub fn plan_outputs(&self, network: Network) -> Result<Vec<SweepOutput>, String> {
        let destination = resolve_output(&self.destination, network)
            .map_err(|e| format!("destination address: {e}"))?;
        if self.fee_zat == 0 {
            return Ok(vec![destination]);
        }
        let fee =
            resolve_output(&self.fee_address, network).map_err(|e| format!("fee address: {e}"))?;
        Ok(vec![destination, fee])
    }

    /// The ZIP-317 network fee this request will pay, without touching the network.
    ///
    /// It depends on how many notes are being spent as well as on the outputs: Ironwood
    /// charges `max(spends, outputs)` actions.
    pub fn network_fee_zat(&self, network: Network) -> Result<u64, String> {
        Ok(network_fee_zat(
            self.notes.len(),
            &self.plan_outputs(network)?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const M1_TXID: &str = "281e9f7bffa5bffc8ee1287cc6e245cc59eee302727ea9d93c7f8e5a99341d43";

    #[test]
    fn a_display_txid_reverses_into_protocol_order() {
        let bytes = txid_to_protocol_bytes(M1_TXID).unwrap();
        assert_eq!(bytes.len(), 32);
        assert_eq!(bytes[0], 0x43);
        assert_eq!(bytes[31], 0x28);
        // And reversing it back gives the display form.
        let mut back = bytes.clone();
        back.reverse();
        assert_eq!(hex::encode(back), M1_TXID);
    }

    #[test]
    fn bad_txids_are_rejected() {
        assert!(txid_to_protocol_bytes("").is_err());
        assert!(txid_to_protocol_bytes("zz").is_err());
        assert!(txid_to_protocol_bytes(&"ab".repeat(31)).is_err());
    }

    #[test]
    fn a_young_envelope_gets_a_tip_anchor() {
        assert_eq!(anchor_height(3_490_472, 3_490_490), 3_490_490);
        assert_eq!(
            anchor_height(3_490_472, 3_490_472 + ANCHOR_WALK_CAP),
            3_490_472 + ANCHOR_WALK_CAP
        );
    }

    #[test]
    fn an_old_envelope_walks_no_further_than_the_cap() {
        // One block past the cap: the anchor stops at the cap, not at the tip and not
        // back at the note's own block.
        assert_eq!(
            anchor_height(3_490_472, 3_490_472 + ANCHOR_WALK_CAP + 1),
            3_490_472 + ANCHOR_WALK_CAP
        );
        // A very old envelope: still exactly `cap` blocks of walk.
        assert_eq!(
            anchor_height(3_000_000, 3_490_472),
            3_000_000 + ANCHOR_WALK_CAP
        );
    }

    #[test]
    fn the_cap_is_the_documented_one() {
        // 24 blocks, about half an hour of mainnet. D18.
        assert_eq!(ANCHOR_WALK_CAP, 24);
    }

    #[test]
    fn the_anchor_never_overflows_near_the_end_of_the_range() {
        assert_eq!(anchor_height(u32::MAX - 1, u32::MAX), u32::MAX);
    }

    #[test]
    fn a_note_in_the_tip_block_anchors_there() {
        assert_eq!(anchor_height(3_490_472, 3_490_472), 3_490_472);
        // A tip behind the note (a lagging server) never walks backwards.
        assert_eq!(anchor_height(3_490_472, 3_490_000), 3_490_472);
    }

    #[test]
    fn the_stage_order_is_the_documented_one() {
        assert_eq!(STAGES, ["witness", "keys", "proving", "broadcast", "done"]);
    }
}
