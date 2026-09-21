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
//! [`ANCHOR_WALK_LIMIT`] picks between them: walk forward when the envelope is young
//! enough that the walk is cheap, and fall back to the same-block anchor when it is not.
//! A recipient opening a link minutes after it was funded — the normal case — gets the
//! recent anchor.
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

use crate::scan::parse_transaction;
use crate::spend::{
    build_and_prove, network_fee_zat, plan_amounts, resolve_output, spend_keys_from_secret,
    SweepOutput, SweepPlan, WitnessScan,
};
use crate::{memo_bytes, ufvk_from_secret};

/// How far back an envelope can be and still get a chain-tip anchor.
///
/// About 1,500 blocks is a day and a half of mainnet at 75 s per block. Beyond that the
/// forward walk stops being a rounding error on the open flow and the same-block anchor
/// is used instead.
pub const ANCHOR_WALK_LIMIT: u32 = 1_500;

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
    pub note: NoteRef,
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

/// Picks the anchor height for an envelope mined at `note_height`, given the chain tip.
///
/// See the module docs. Returns the height whose Ironwood tree root becomes the anchor.
pub fn anchor_height(note_height: u32, tip_height: u32) -> u32 {
    if tip_height <= note_height {
        // A tip at or below the note's block means the note is in the newest block we
        // know of; its own block is the only anchor available.
        note_height
    } else if tip_height - note_height <= ANCHOR_WALK_LIMIT {
        tip_height
    } else {
        note_height
    }
}

/// Runs a whole sweep: fetch the note, witness it, build and prove, and optionally send.
///
/// `on_stage` is called with `(stage, detail)` in the order given by [`STAGES`]. It is a
/// progress report and nothing more: whatever it does cannot fail the sweep.
pub async fn sweep<T>(
    client: &mut CompactTxStreamerClient<T>,
    request: &SweepRequest,
    on_stage: &mut dyn FnMut(&str, &str),
) -> Result<SweepOutcome, String>
where
    T: tonic::client::GrpcService<tonic::body::Body>,
    T::Error: Into<StdError>,
    T::ResponseBody: Body<Data = Bytes> + Send + 'static,
    <T::ResponseBody as Body>::Error: Into<StdError> + Send,
{
    let network = request.network;
    let note_height = request.note.height;

    // --- stage: witness ----------------------------------------------------
    on_stage("witness", "finding the envelope's note");

    let txid_protocol = txid_to_protocol_bytes(&request.note.txid)?;

    let tip = client
        .get_latest_block(ChainSpec {})
        .await
        .map_err(|e| format!("GetLatestBlock failed: {}", e.message()))?
        .into_inner()
        .height;
    let tip_height = u32::try_from(tip).map_err(|_| format!("chain tip height {tip} is absurd"))?;

    // Re-derive the note from the secret rather than trusting anything the caller says
    // about it: fetch the funding transaction and decrypt the action ourselves.
    let raw = client
        .get_transaction(TxFilter {
            block: None,
            index: 0,
            hash: txid_protocol.clone(),
        })
        .await
        .map_err(|e| format!("GetTransaction failed: {}", e.message()))?
        .into_inner();

    let funding_tx = parse_transaction(&raw.data, note_height, network)?;
    let bundle = funding_tx
        .ironwood_bundle()
        .ok_or("that transaction has no Ironwood bundle")?;

    let ufvk = ufvk_from_secret(&request.secret_b64url, network)?;
    let fvk = ufvk
        .orchard()
        .ok_or("the link's viewing key carries no Orchard key")?;

    let idx = request.note.action_index;
    let (note, _, _) = [
        orchard::keys::Scope::External,
        orchard::keys::Scope::Internal,
    ]
    .iter()
    .find_map(|scope| bundle.decrypt_output_with_key(idx, &fvk.to_ivk(*scope)))
    .ok_or_else(|| {
        format!(
            "Ironwood action {idx} of that transaction does not decrypt with this \
                 link's viewing key"
        )
    })?;
    let note_value_zat = note.value().inner();

    // Replay the Ironwood tree from the frontier just before the note's block.
    let start_tree = client
        .get_tree_state(BlockId {
            height: u64::from(note_height - 1),
            hash: Vec::new(),
        })
        .await
        .map_err(|e| format!("GetTreeState({}) failed: {}", note_height - 1, e.message()))?
        .into_inner()
        .ironwood_tree()
        .map_err(|e| format!("could not parse the Ironwood frontier: {e}"))?;

    let mut scan = WitnessScan::new(start_tree);

    let note_block = client
        .get_block(BlockId {
            height: u64::from(note_height),
            hash: Vec::new(),
        })
        .await
        .map_err(|e| format!("GetBlock({note_height}) failed: {}", e.message()))?
        .into_inner();
    scan.append_block(&note_block, Some((&txid_protocol, idx)))?;

    if scan.position().is_none() {
        return Err(format!(
            "block {note_height} has no Ironwood action {idx} in transaction {}",
            request.note.txid
        ));
    }

    // The ordering guard, at the note's own block: if the replay is wrong it is wrong
    // here, before any further blocks have been streamed.
    let same_block_root = tree_state_root(client, note_height).await?;
    if scan.tree_root_hex() != same_block_root {
        return Err(format!(
            "the replayed Ironwood root at block {note_height} is {} but the server \
             reports {same_block_root}",
            scan.tree_root_hex()
        ));
    }

    let anchor_at = anchor_height(note_height, tip_height);
    if anchor_at > note_height {
        let mut stream = client
            .get_block_range(BlockRange {
                start: Some(BlockId {
                    height: u64::from(note_height + 1),
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
        while let Some(block) = stream.next().await {
            let block = block.map_err(|e| format!("block stream failed: {}", e.message()))?;
            scan.append_block(&block, None)?;
            walked += 1;
            if walked.is_multiple_of(100) {
                on_stage(
                    "witness",
                    &format!("rolling the witness forward, {walked} blocks"),
                );
            }
        }
    }

    let anchor_root = tree_state_root(client, anchor_at).await?;
    let position = scan.position().unwrap_or_default();
    let appended = scan.appended();
    let (merkle_path, anchor) = scan.finish(&anchor_root)?;
    on_stage(
        "witness",
        &format!(
            "note at position {position}, anchor {anchor_root} at height {anchor_at} \
             ({appended} commitments replayed)"
        ),
    );

    // --- stage: keys -------------------------------------------------------
    on_stage("keys", "deriving the envelope's spending key");
    let keys = spend_keys_from_secret(&request.secret_b64url, network)?;

    // --- stage: proving ----------------------------------------------------
    let outputs = request.plan_outputs(network)?;
    let amounts = plan_amounts(note_value_zat, request.fee_zat, &outputs)?;

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
            "proving a 2-action Ironwood bundle, {} zatoshi to the destination",
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
        note,
        merkle_path,
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
    pub fn network_fee_zat(&self, network: Network) -> Result<u64, String> {
        Ok(network_fee_zat(&self.plan_outputs(network)?))
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
        assert_eq!(anchor_height(3_490_472, 3_490_500), 3_490_500);
        assert_eq!(
            anchor_height(3_490_472, 3_490_472 + ANCHOR_WALK_LIMIT),
            3_490_472 + ANCHOR_WALK_LIMIT
        );
    }

    #[test]
    fn an_old_envelope_falls_back_to_its_own_block() {
        assert_eq!(
            anchor_height(3_490_472, 3_490_472 + ANCHOR_WALK_LIMIT + 1),
            3_490_472
        );
        assert_eq!(anchor_height(3_000_000, 3_490_472), 3_000_000);
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
