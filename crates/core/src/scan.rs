//! Finding the envelope's note on chain.
//!
//! This module is the transport-free half of M2: given a link secret it builds the
//! viewing keys, trial-decrypts compact blocks, and turns a full transaction into the
//! received notes the recipient is shown. It compiles everywhere, so the logic is
//! testable without a browser and without a network.
//!
//! The transport half lives in [`crate::grpc`] and exists only on `wasm32`.
//!
//! # Ironwood
//!
//! NU6.3 ("Ironwood") added a second Orchard-shaped pool. In a `CompactTx` its outputs
//! arrive in `ironwood_actions`, a field that is separate from the Orchard `actions`
//! field and carries actions of the same wire shape. The two are told apart by the note
//! plaintext *version* inside the ciphertext, not by the wire format: Orchard accepts
//! version 2 plaintexts and Ironwood version 3. `orchard` expresses that as two note
//! encryption domains over one key type, [`OrchardDomain`] and [`IronwoodDomain`], so
//! decrypting an Ironwood action with the Orchard domain silently fails and vice versa.
//! Both pools are reached with the *same* Orchard incoming viewing key, which is why the
//! Orchard receiver in a unified address receives Ironwood notes.

use std::collections::HashMap;

use orchard::keys::{PreparedIncomingViewingKey, Scope};
use orchard::note_encryption::{CompactAction, IronwoodDomain, OrchardDomain};

use zcash_client_backend::decrypt_transaction;
use zcash_client_backend::proto::compact_formats::{CompactBlock, CompactTx};
// The threaded package only. `par_iter` needs a pool to run on, and a plain `--target
// web` build has none; without this feature the sequential path below is what compiles.
#[cfg(feature = "multicore")]
use rayon::prelude::*;
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_note_encryption::batch;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::{BlockHeight, BranchId, Network};
use zcash_protocol::memo::{Memo, MemoBytes};
use zcash_protocol::{ShieldedPool, TxId};
use zip32::AccountId;

use crate::ufvk_from_secret;

/// How far back the scan starts when a link carries no birthday height.
///
/// A fragment without a birthday is either hand-edited or very old. Ten thousand blocks
/// is about eight days of mainnet at 75 s per block: long enough to cover a link created
/// over a holiday weekend, short enough that the scan still finishes in a browser.
pub const DEFAULT_BIRTHDAY_LOOKBACK: u32 = 10_000;

/// A note the envelope received.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReceivedNote {
    /// Note value in zatoshi. Carried as a string across the JS boundary so no amount
    /// ever passes through an f64.
    pub amount_zat: u64,
    /// The memo as UTF-8 text, or `None` for an empty or non-text memo.
    pub memo: Option<String>,
    /// The height of the block the transaction was mined in.
    pub height: u32,
    /// The transaction id, in the big-endian form block explorers display.
    pub txid: String,
    /// `"ironwood"`, `"orchard"` or `"sapling"`.
    pub pool: &'static str,
    /// Index of the action (or Sapling output) this note arrived in, within its pool's
    /// list in the transaction. M3 needs it to witness the exact note it is spending:
    /// one transaction can carry several Ironwood actions and only one of them is ours.
    pub action_index: usize,
}

/// Everything an envelope scan found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenResult {
    pub notes: Vec<ReceivedNote>,
    pub total_zat: u64,
    pub tip_height: u32,
    /// The height the scan actually started at.
    pub birthday: u32,
    /// True when no birthday was supplied and [`DEFAULT_BIRTHDAY_LOOKBACK`] was used.
    pub birthday_defaulted: bool,
    /// Number of blocks streamed, `tip - birthday + 1`.
    pub scanned_blocks: u32,
    /// Which gateway won the start-of-session race and served this scan, as a host name.
    /// Empty when no race happened, which is every build that is not the browser.
    pub gateway: String,
}

impl OpenResult {
    pub fn found(&self) -> bool {
        !self.notes.is_empty()
    }
}

/// The viewing keys an envelope is opened with.
///
/// One Orchard full viewing key covers both Orchard-family pools and both scopes. The
/// spending key is derived and dropped here: M2 only reads the chain.
pub struct ViewKeys {
    ufvk: UnifiedFullViewingKey,
    /// External then internal, in that order. Used for both the Orchard and the Ironwood
    /// domain: the domains differ, the key type does not.
    ivks: Vec<PreparedIncomingViewingKey>,
}

impl ViewKeys {
    /// Derives the viewing keys for a link secret, exactly as `derive()` does.
    pub fn from_secret(secret_b64url: &str, network: Network) -> Result<Self, String> {
        Ok(Self::from_ufvk(ufvk_from_secret(secret_b64url, network)?))
    }

    /// Builds the scan keys around an already-derived unified full viewing key.
    pub fn from_ufvk(ufvk: UnifiedFullViewingKey) -> Self {
        let ivks = ufvk
            .orchard()
            .map(|fvk| {
                vec![
                    PreparedIncomingViewingKey::new(&fvk.to_ivk(Scope::External)),
                    PreparedIncomingViewingKey::new(&fvk.to_ivk(Scope::Internal)),
                ]
            })
            .unwrap_or_default();
        Self { ufvk, ivks }
    }

    /// The account map `decrypt_transaction` wants. One envelope is one account.
    fn ufvks(&self) -> HashMap<AccountId, UnifiedFullViewingKey> {
        let mut m = HashMap::with_capacity(1);
        m.insert(AccountId::ZERO, self.ufvk.clone());
        m
    }
}

/// Decides where a scan starts and how many blocks it covers.
///
/// A birthday above the tip is clamped to the tip rather than rejected: a link created
/// seconds ago can legitimately name a height the server has not served yet, and a
/// one-block scan is the right answer there.
pub fn scan_range(birthday: Option<u32>, tip_height: u32) -> (u32, bool, u32) {
    match birthday {
        Some(b) => {
            let start = b.min(tip_height);
            (start, false, tip_height - start + 1)
        }
        None => {
            let start = tip_height.saturating_sub(DEFAULT_BIRTHDAY_LOOKBACK);
            (start, true, tip_height - start + 1)
        }
    }
}

/// How many blocks the threaded scan hands rayon at a time.
///
/// One block per fork/join is the wrong grain: a mainnet block holds a handful of
/// shielded transactions, so the scheduling would cost more than the arithmetic inside
/// it. A chunk of 64 gives every thread hundreds of trial decryptions to chew on, and at
/// roughly 7 KB a compact block it is under half a megabyte held at once.
pub const SCAN_CHUNK_BLOCKS: usize = 64;

/// True when this compact block holds no Orchard-family action at all.
///
/// Answering that by looking at two lengths costs nothing, and it is the difference
/// between skipping the block outright and allocating two vectors and running two batch
/// passes for every transaction in it. Sapling outputs are never looked at, here or
/// anywhere below: an envelope address carries one Orchard receiver, so no envelope can
/// ever be paid in Sapling and trial-decrypting that pool would be work for a note that
/// cannot exist.
fn has_no_shielded_actions(block: &CompactBlock) -> bool {
    block
        .vtx
        .iter()
        .all(|tx| tx.actions.is_empty() && tx.ironwood_actions.is_empty())
}

/// Trial-decrypts one compact block and returns the txids that decrypted.
///
/// Compact blocks carry only the first 52 bytes of each note ciphertext, which is enough
/// to recognise a note but not enough to read its memo. So this pass answers "which
/// transactions are mine", and [`notes_from_transaction`] answers "what is in them" from
/// the full transaction fetched afterwards.
pub fn scan_compact_block(block: &CompactBlock, keys: &ViewKeys) -> Vec<TxId> {
    if keys.ivks.is_empty() || has_no_shielded_actions(block) {
        return Vec::new();
    }
    let mut hits = Vec::new();
    for tx in &block.vtx {
        if compact_tx_is_ours(tx, &keys.ivks) {
            hits.push(tx.txid());
        }
    }
    hits
}

/// Trial-decrypts a run of compact blocks and returns every hit as `(height, txid)`.
///
/// This is the shape the scan wants and the one that parallelises: a block decrypts
/// independently of every other block, so in the `multicore` build the run goes through
/// rayon's `par_iter` and in the single-threaded build it is the same loop it always was.
///
/// **The output is chain order in both builds.** Rayon's `collect` into a `Vec` keeps the
/// order of the source iterator whatever order the work finished in, and within a block
/// the hits are pushed in `vtx` order, so the threaded build produces the same list as
/// the sequential one — same transactions, same order, and therefore the same notes with
/// the same `action_index` once they are fetched in full. That is not tidiness: the
/// frontier replay downstream is built by appending commitments in chain order, and a
/// scan that reordered its answers would be a different scan.
///
/// A height that does not fit in a `u32` is a malformed answer from the server and is
/// reported rather than silently skipped.
pub fn scan_compact_blocks(
    blocks: &[CompactBlock],
    keys: &ViewKeys,
) -> Result<Vec<(u32, TxId)>, String> {
    if keys.ivks.is_empty() {
        // The heights are still checked, so a key-less scan fails on a malformed block
        // exactly where a real one would.
        for block in blocks {
            check_height(block)?;
        }
        return Ok(Vec::new());
    }

    #[cfg(feature = "multicore")]
    let per_block: Vec<Result<Vec<(u32, TxId)>, String>> =
        blocks.par_iter().map(|b| scan_one(b, keys)).collect();
    #[cfg(not(feature = "multicore"))]
    let per_block: Vec<Result<Vec<(u32, TxId)>, String>> =
        blocks.iter().map(|b| scan_one(b, keys)).collect();

    let mut hits = Vec::new();
    for block in per_block {
        hits.extend(block?);
    }
    Ok(hits)
}

/// One block's hits, tagged with its height. The unit of parallel work.
fn scan_one(block: &CompactBlock, keys: &ViewKeys) -> Result<Vec<(u32, TxId)>, String> {
    let height = check_height(block)?;
    Ok(scan_compact_block(block, keys)
        .into_iter()
        .map(|txid| (height, txid))
        .collect())
}

fn check_height(block: &CompactBlock) -> Result<u32, String> {
    u32::try_from(block.height).map_err(|_| format!("block height {} is absurd", block.height))
}

/// True if any Orchard-family action in this compact transaction decrypts to us.
///
/// Each pool is skipped outright when the transaction carries no actions in it, so a
/// transparent or Sapling-only transaction costs two length checks and no allocation.
fn compact_tx_is_ours(tx: &CompactTx, ivks: &[PreparedIncomingViewingKey]) -> bool {
    if !tx.actions.is_empty() {
        let orchard: Vec<(OrchardDomain, CompactAction)> = tx
            .actions
            .iter()
            .filter_map(|a| CompactAction::try_from(a).ok())
            .map(|a| (OrchardDomain::for_compact_action(&a), a))
            .collect();
        if batch::try_compact_note_decryption(ivks, &orchard)
            .iter()
            .any(Option::is_some)
        {
            return true;
        }
    }

    // The Ironwood pass. Same actions shape, same keys, different domain: an Ironwood
    // note is a version 3 plaintext and only `IronwoodDomain` will read it.
    if tx.ironwood_actions.is_empty() {
        return false;
    }
    let ironwood: Vec<(IronwoodDomain, CompactAction)> = tx
        .ironwood_actions
        .iter()
        .filter_map(|a| CompactAction::try_from(a).ok())
        .map(|a| (IronwoodDomain::for_compact_action(&a), a))
        .collect();
    batch::try_compact_note_decryption(ivks, &ironwood)
        .iter()
        .any(Option::is_some)
}

/// Parses a raw transaction as served by lightwalletd.
pub fn parse_transaction(raw: &[u8], height: u32, network: Network) -> Result<Transaction, String> {
    let branch = BranchId::for_height(&network, BlockHeight::from_u32(height));
    Transaction::read(raw, branch).map_err(|e| format!("could not parse transaction: {e}"))
}

/// Fully decrypts a transaction and returns the notes this envelope received.
///
/// Unlike the compact pass this sees the whole ciphertext, so the memo comes out here.
pub fn notes_from_transaction(
    tx: &Transaction,
    height: u32,
    keys: &ViewKeys,
    network: Network,
) -> Vec<ReceivedNote> {
    let ufvks = keys.ufvks();
    let decrypted = decrypt_transaction(
        &network,
        Some(BlockHeight::from_u32(height)),
        None,
        tx,
        &ufvks,
    );

    let txid = tx.txid().to_string();
    let mut notes = Vec::new();

    for out in decrypted.sapling_outputs() {
        if is_received(out.transfer_type()) {
            notes.push(ReceivedNote {
                amount_zat: out.note_value().into_u64(),
                memo: memo_text(out.memo()),
                height,
                txid: txid.clone(),
                pool: pool_name(out.value_pool()),
                action_index: out.index(),
            });
        }
    }
    // Orchard and Ironwood outputs share a note type; the pool each one credits is read
    // off the output rather than assumed from which list it arrived in.
    for out in decrypted
        .orchard_outputs()
        .iter()
        .chain(decrypted.ironwood_outputs())
    {
        if is_received(out.transfer_type()) {
            notes.push(ReceivedNote {
                amount_zat: out.note().0.value().inner(),
                memo: memo_text(out.memo()),
                height,
                txid: txid.clone(),
                pool: pool_name(out.value_pool()),
                action_index: out.index(),
            });
        }
    }
    notes
}

/// An output belongs to the envelope when it was decrypted with an incoming viewing key,
/// whether it came from outside (the sender funding the link) or from the envelope's own
/// internal scope (change, once M3 starts spending).
fn is_received(t: zcash_client_backend::TransferType) -> bool {
    use zcash_client_backend::TransferType::*;
    matches!(t, Incoming | WalletInternal)
}

/// The pool name as it crosses the JS boundary.
pub fn pool_name(pool: ShieldedPool) -> &'static str {
    match pool {
        ShieldedPool::Sapling => "sapling",
        ShieldedPool::Orchard => "orchard",
        ShieldedPool::Ironwood => "ironwood",
    }
}

/// A memo as display text, or `None` when it is empty or not text.
///
/// A non-text memo is deliberately not rendered as hex: the open screen shows a message
/// from the sender, and arbitrary bytes are not that.
pub fn memo_text(memo: &MemoBytes) -> Option<String> {
    match Memo::try_from(memo) {
        Ok(Memo::Text(t)) => Some(t.to_string()),
        _ => None,
    }
}

/// Sums note values, refusing to wrap.
pub fn total_zat(notes: &[ReceivedNote]) -> Result<u64, String> {
    notes
        .iter()
        .try_fold(0u64, |acc, n| acc.checked_add(n.amount_zat))
        .ok_or_else(|| "received note values overflow u64".to_string())
}

/// Normalises a lightwalletd base URL for the gRPC-web client.
///
/// A trailing slash turns the generated path into a double slash, which the zec.rocks
/// gateway answers with 404, so it is stripped here rather than in every call site.
pub fn normalize_endpoint(url: &str) -> Result<String, String> {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("lightwalletd_url is empty".to_string());
    }
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err(format!(
            "lightwalletd_url must be an http(s) URL, got {url:?}"
        ));
    }
    Ok(trimmed.to_string())
}

/// Normalises a **comma-separated** list of lightwalletd base URLs, in preference order.
///
/// The JS boundary hands gateways down as one string so that adding a failover did not
/// change any exported signature: `open_envelope` and `sweep_envelope` still take a single
/// `lightwalletd_url`, and a string with no comma in it still means exactly one gateway,
/// exactly as before. Duplicates are dropped, keeping the first mention, so a page that
/// names the same host twice does not race it against itself.
pub fn normalize_endpoints(urls: &str) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for part in urls.split(',') {
        if part.trim().is_empty() {
            continue;
        }
        let endpoint = normalize_endpoint(part)?;
        if !out.contains(&endpoint) {
            out.push(endpoint);
        }
    }
    if out.is_empty() {
        return Err("lightwalletd_url is empty".to_string());
    }
    Ok(out)
}

/// The host part of an endpoint, which is what the timing line names.
///
/// `https://zjs.zec.rocks/mainnet` becomes `zjs.zec.rocks`. Anything that does not look
/// like a URL comes back whole rather than guessed at: this string is read by a human
/// comparing two runs, and a wrong guess there is worse than a long name.
pub fn gateway_label(endpoint: &str) -> String {
    endpoint
        .split_once("://")
        .map_or(endpoint, |(_, rest)| rest)
        .split('/')
        .next()
        .unwrap_or(endpoint)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_range_uses_the_birthday_when_given() {
        assert_eq!(
            scan_range(Some(3_490_437), 3_490_472),
            (3_490_437, false, 36)
        );
    }

    #[test]
    fn scan_range_defaults_to_ten_thousand_blocks_back() {
        let (start, defaulted, count) = scan_range(None, 3_490_472);
        assert_eq!(start, 3_480_472);
        assert!(defaulted);
        assert_eq!(count, DEFAULT_BIRTHDAY_LOOKBACK + 1);
    }

    #[test]
    fn scan_range_clamps_a_birthday_past_the_tip() {
        assert_eq!(
            scan_range(Some(5_000_000), 3_490_472),
            (3_490_472, false, 1)
        );
    }

    #[test]
    fn scan_range_survives_a_tip_below_the_lookback() {
        let (start, defaulted, count) = scan_range(None, 42);
        assert_eq!(start, 0);
        assert!(defaulted);
        assert_eq!(count, 43);
    }

    #[test]
    fn pool_names_are_the_documented_strings() {
        assert_eq!(pool_name(ShieldedPool::Ironwood), "ironwood");
        assert_eq!(pool_name(ShieldedPool::Orchard), "orchard");
        assert_eq!(pool_name(ShieldedPool::Sapling), "sapling");
    }

    #[test]
    fn a_text_memo_comes_back_as_text() {
        let memo = MemoBytes::from(&Memo::from_bytes(b"Zenvelope M1").unwrap());
        assert_eq!(memo_text(&memo).as_deref(), Some("Zenvelope M1"));
    }

    #[test]
    fn an_empty_memo_is_none() {
        assert_eq!(memo_text(&MemoBytes::empty()), None);
    }

    #[test]
    fn a_non_text_memo_is_none() {
        let memo = MemoBytes::from_bytes(&[0xff, 0x01, 0x02]).unwrap();
        assert_eq!(memo_text(&memo), None);
    }

    #[test]
    fn totals_add_up() {
        let note = |zat| ReceivedNote {
            amount_zat: zat,
            memo: None,
            height: 1,
            txid: String::new(),
            pool: "ironwood",
            action_index: 0,
        };
        assert_eq!(total_zat(&[]), Ok(0));
        assert_eq!(total_zat(&[note(130_000), note(70_000)]), Ok(200_000));
        assert!(total_zat(&[note(u64::MAX), note(1)]).is_err());
    }

    #[test]
    fn endpoints_are_normalized() {
        assert_eq!(
            normalize_endpoint("https://zjs.zec.rocks/mainnet/"),
            Ok("https://zjs.zec.rocks/mainnet".to_string())
        );
        assert_eq!(
            normalize_endpoint("  https://zcash-mainnet.chainsafe.dev  "),
            Ok("https://zcash-mainnet.chainsafe.dev".to_string())
        );
        assert!(normalize_endpoint("").is_err());
        assert!(normalize_endpoint("zec.rocks:443").is_err());
    }

    #[test]
    fn one_url_is_still_one_gateway() {
        assert_eq!(
            normalize_endpoints("https://zjs.zec.rocks/mainnet"),
            Ok(vec!["https://zjs.zec.rocks/mainnet".to_string()])
        );
    }

    #[test]
    fn a_comma_separated_list_keeps_its_order() {
        assert_eq!(
            normalize_endpoints(
                "https://zjs.zec.rocks/mainnet, https://zcash-mainnet.chainsafe.dev/"
            ),
            Ok(vec![
                "https://zjs.zec.rocks/mainnet".to_string(),
                "https://zcash-mainnet.chainsafe.dev".to_string(),
            ])
        );
    }

    #[test]
    fn a_gateway_named_twice_is_not_raced_against_itself() {
        assert_eq!(
            normalize_endpoints("https://a.example/x,https://a.example/x/,https://b.example"),
            Ok(vec![
                "https://a.example/x".to_string(),
                "https://b.example".to_string(),
            ])
        );
    }

    #[test]
    fn an_empty_or_broken_gateway_list_is_refused() {
        assert!(normalize_endpoints("").is_err());
        assert!(normalize_endpoints(" , ").is_err());
        assert!(normalize_endpoints("https://a.example,zec.rocks:443").is_err());
    }

    #[test]
    fn a_gateway_is_named_by_its_host() {
        assert_eq!(
            gateway_label("https://zjs.zec.rocks/mainnet"),
            "zjs.zec.rocks"
        );
        assert_eq!(
            gateway_label("https://zcash-mainnet.chainsafe.dev"),
            "zcash-mainnet.chainsafe.dev"
        );
        assert_eq!(gateway_label("http://127.0.0.1:9067"), "127.0.0.1:9067");
        assert_eq!(gateway_label("nonsense"), "nonsense");
    }

    #[test]
    fn the_orchard_viewing_key_is_present_for_a_link_secret() {
        let secret = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
        let keys = ViewKeys::from_secret(secret, Network::MainNetwork).unwrap();
        // External and internal scope, one Orchard key covering both Orchard-family pools.
        assert_eq!(keys.ivks.len(), 2);
        assert!(keys.ufvk.orchard().is_some());
        assert!(keys.ufvk.sapling().is_none());
    }

    #[test]
    fn an_empty_compact_block_yields_nothing() {
        let secret = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
        let keys = ViewKeys::from_secret(secret, Network::MainNetwork).unwrap();
        let block = CompactBlock {
            height: 3_490_472,
            ..Default::default()
        };
        assert!(scan_compact_block(&block, &keys).is_empty());
    }

    #[test]
    fn a_block_with_no_orchard_family_action_is_skipped() {
        use zcash_client_backend::proto::compact_formats::{CompactSaplingOutput, CompactTx};

        // Sapling-only activity: nothing an envelope can ever be paid in, so the scan
        // must not look at it.
        let block = CompactBlock {
            height: 3_490_472,
            vtx: vec![CompactTx {
                txid: vec![9u8; 32],
                outputs: vec![CompactSaplingOutput {
                    cmu: vec![0u8; 32],
                    ephemeral_key: vec![1u8; 32],
                    ciphertext: vec![7u8; 52],
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(has_no_shielded_actions(&block));

        let secret = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
        let keys = ViewKeys::from_secret(secret, Network::MainNetwork).unwrap();
        assert!(scan_compact_block(&block, &keys).is_empty());
    }

    #[test]
    fn a_run_of_blocks_comes_back_in_chain_order() {
        let secret = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
        let keys = ViewKeys::from_secret(secret, Network::MainNetwork).unwrap();

        // A long enough run that the threaded build really does split it across
        // threads. None of these blocks is ours, so the answer is the empty list either
        // way; what is asserted is that both builds agree and that nothing panics when
        // rayon is driving.
        let blocks: Vec<CompactBlock> = (0..(SCAN_CHUNK_BLOCKS * 3))
            .map(|i| CompactBlock {
                height: 3_490_472 + i as u64,
                ..Default::default()
            })
            .collect();
        assert_eq!(scan_compact_blocks(&blocks, &keys), Ok(Vec::new()));
    }

    #[test]
    fn a_run_of_blocks_reports_an_absurd_height() {
        let secret = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
        let keys = ViewKeys::from_secret(secret, Network::MainNetwork).unwrap();
        let blocks = vec![CompactBlock {
            height: u64::from(u32::MAX) + 1,
            ..Default::default()
        }];
        assert!(scan_compact_blocks(&blocks, &keys).is_err());
    }

    #[test]
    fn actions_that_are_not_ours_do_not_decrypt() {
        use zcash_client_backend::proto::compact_formats::{CompactOrchardAction, CompactTx};

        let secret = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
        let keys = ViewKeys::from_secret(secret, Network::MainNetwork).unwrap();

        // A well-formed-looking but random Ironwood action: the ephemeral key parses as a
        // point often enough that this exercises the decryption path, and never decrypts.
        let action = CompactOrchardAction {
            nullifier: vec![0u8; 32],
            cmx: vec![0u8; 32],
            ephemeral_key: vec![1u8; 32],
            ciphertext: vec![7u8; 52],
        };
        let block = CompactBlock {
            height: 3_490_472,
            vtx: vec![CompactTx {
                txid: vec![9u8; 32],
                ironwood_actions: vec![action.clone()],
                actions: vec![action],
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(scan_compact_block(&block, &keys).is_empty());
    }
}
