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
//!
//! # Spent detection
//!
//! Finding a note is not the same as finding money: an envelope that was already swept
//! still has its note on chain. So the same walk over compact blocks also watches for
//! the note being spent. A compact action carries 52 bytes of note plaintext, which is
//! the whole note (version, diversifier, value, rseed), and its `rho` is the action's
//! own nullifier field, so the compact pass can rebuild the full [`orchard::Note`] and
//! derive its nullifier with the envelope's full viewing key, `Note::nullifier(fvk)` —
//! the very call orchard's builder makes when the sweep spends that note. Every action's
//! `nullifier` field (Ironwood actions for an Ironwood note, Orchard actions for an
//! Orchard note) is then compared against that set. See [`SpendWatch`].

use std::collections::HashMap;

use orchard::keys::{FullViewingKey, PreparedIncomingViewingKey, Scope};
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
    /// The note's nullifier, derived with the envelope's full viewing key exactly as the
    /// sweep derives it. `None` for a Sapling note, which an envelope cannot receive and
    /// whose spend is not watched.
    pub nullifier: Option<[u8; 32]>,
    /// Where this note was spent, if the scan saw its nullifier on chain.
    pub spent: Option<SpentAt>,
}

/// The transaction that spent a note, and the block it was mined in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpentAt {
    /// Display (big-endian) txid, like [`ReceivedNote::txid`].
    pub txid: String,
    pub height: u32,
    /// That block's time, unix seconds, from its compact header. Shown as a date.
    pub time: u32,
}

/// Everything an envelope scan found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenResult {
    /// Every note the envelope ever received, spent or not.
    pub notes: Vec<ReceivedNote>,
    /// The sum of the **unspent** notes: what the envelope holds now.
    pub total_zat: u64,
    /// The sum of the notes that were already spent.
    pub spent_zat: u64,
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
    /// True when the envelope ever received anything, spent or not.
    pub fn found(&self) -> bool {
        !self.notes.is_empty()
    }

    /// True when notes were found and every one of them has been spent: the envelope
    /// was already opened and swept.
    pub fn all_spent(&self) -> bool {
        self.found() && self.notes.iter().all(|n| n.spent.is_some())
    }
}

/// The viewing keys an envelope is opened with.
///
/// One Orchard full viewing key covers both Orchard-family pools and both scopes. The
/// spending key is derived and dropped here: M2 only reads the chain.
pub struct ViewKeys {
    ufvk: UnifiedFullViewingKey,
    /// The Orchard full viewing key: what a note's nullifier is derived with.
    fvk: Option<FullViewingKey>,
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
        let fvk = ufvk.orchard().cloned();
        Self { ufvk, fvk, ivks }
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
    scan_block_notes(block, keys)
        .into_iter()
        .map(|(txid, _)| txid)
        .collect()
}

/// A nullifier found for one of the envelope's notes, with the pool it lives in.
type FoundNullifier = ([u8; 32], NotePool);

/// One block's decrypted transactions, each with the nullifiers of the notes in it.
fn scan_block_notes(block: &CompactBlock, keys: &ViewKeys) -> Vec<(TxId, Vec<FoundNullifier>)> {
    let fvk = match &keys.fvk {
        Some(fvk) if !keys.ivks.is_empty() => fvk,
        _ => return Vec::new(),
    };
    if has_no_shielded_actions(block) {
        return Vec::new();
    }
    let mut hits = Vec::new();
    for tx in &block.vtx {
        let found = compact_tx_notes(tx, &keys.ivks, fvk);
        if !found.is_empty() {
            hits.push((tx.txid(), found));
        }
    }
    hits
}

/// Which Orchard-family pool a watched nullifier would be revealed in.
///
/// An Ironwood note is spent by an Ironwood action and an Orchard note by an Orchard
/// action, so each nullifier is only compared against its own pool's list.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NotePool {
    Orchard,
    Ironwood,
}

/// Derives a note's nullifier with the envelope's full viewing key.
///
/// This is the derivation the sweep relies on: `add_ironwood_spend(fvk, note, path)`
/// hands the note and the same `fvk` to orchard's builder, whose `SpendInfo` puts
/// `note.nullifier(&fvk)` in the spending action. Nothing here is a reimplementation.
pub fn note_nullifier(fvk: &FullViewingKey, note: &orchard::Note) -> [u8; 32] {
    note.nullifier(fvk).to_bytes()
}

/// The nullifiers of the envelope's notes, and where on chain each one was revealed.
///
/// The scan fills the watch list as it decrypts notes and checks every action against
/// it. It is plain data, merged chunk by chunk on the thread that drives the stream, so
/// the threaded scan needs no locks: a chunk's workers only ever read it.
#[derive(Clone, Debug, Default)]
pub struct SpendWatch {
    watched: HashMap<[u8; 32], NotePool>,
    /// Height, txid and block time (unix seconds) of each spend seen.
    spent: HashMap<[u8; 32], (u32, TxId, u32)>,
}

impl SpendWatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts watching for this nullifier in `pool`'s actions.
    pub fn watch(&mut self, nullifier: [u8; 32], pool: NotePool) {
        self.watched.insert(nullifier, pool);
    }

    pub fn is_watching(&self, nullifier: &[u8; 32]) -> bool {
        self.watched.contains_key(nullifier)
    }

    /// Where the note with this nullifier was spent, if the scan saw it.
    pub fn spent_at(&self, nullifier: &[u8; 32]) -> Option<(u32, TxId)> {
        self.spent
            .get(nullifier)
            .map(|&(height, txid, _)| (height, txid))
    }

    /// The block time of that spend, in unix seconds, as the compact block states it.
    pub fn spent_time(&self, nullifier: &[u8; 32]) -> Option<u32> {
        self.spent.get(nullifier).map(|&(_, _, time)| time)
    }

    /// Records a spend. The first one seen in chain order wins; a second would be a
    /// double spend, which consensus rejects, so on a valid chain there is none.
    fn record(&mut self, nullifier: [u8; 32], height: u32, txid: TxId, time: u32) {
        self.spent.entry(nullifier).or_insert((height, txid, time));
    }
}

/// Trial-decrypts a run of compact blocks, returns every hit as `(height, txid)`, and
/// watches for the envelope's notes being spent.
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
/// **Spends.** A run is handled in two steps. First every block is trial-decrypted (in
/// parallel) and the nullifier of each note found is added to `watch`. Then, if `watch`
/// holds anything, every block of the same run is checked (in parallel again) for an
/// action revealing a watched nullifier, and the matches are merged in chain order. The
/// second step runs after the first so that a note funded and spent inside one chunk is
/// still caught. It costs nothing until the envelope's first note turns up and one hash
/// lookup per action after that. `watch` carries over from run to run, so a spend in
/// any later chunk is caught too.
///
/// A height that does not fit in a `u32` is a malformed answer from the server and is
/// reported rather than silently skipped.
pub fn scan_compact_blocks(
    blocks: &[CompactBlock],
    keys: &ViewKeys,
    watch: &mut SpendWatch,
) -> Result<Vec<(u32, TxId)>, String> {
    // Every height is checked first, so a key-less scan fails on a malformed block
    // exactly where a real one would, and nothing below has to.
    let heights = blocks
        .iter()
        .map(check_height)
        .collect::<Result<Vec<u32>, String>>()?;
    if keys.ivks.is_empty() {
        return Ok(Vec::new());
    }

    #[cfg(feature = "multicore")]
    let per_block: Vec<Vec<(TxId, Vec<FoundNullifier>)>> = blocks
        .par_iter()
        .map(|b| scan_block_notes(b, keys))
        .collect();
    #[cfg(not(feature = "multicore"))]
    let per_block: Vec<Vec<(TxId, Vec<FoundNullifier>)>> =
        blocks.iter().map(|b| scan_block_notes(b, keys)).collect();

    let mut hits = Vec::new();
    for (height, found) in heights.iter().zip(per_block) {
        for (txid, notes) in found {
            for (nf, pool) in notes {
                watch.watch(nf, pool);
            }
            hits.push((*height, txid));
        }
    }

    if !watch.watched.is_empty() {
        let watched = &watch.watched;
        #[cfg(feature = "multicore")]
        let spends: Vec<Vec<([u8; 32], TxId)>> =
            blocks.par_iter().map(|b| find_spends(b, watched)).collect();
        #[cfg(not(feature = "multicore"))]
        let spends: Vec<Vec<([u8; 32], TxId)>> =
            blocks.iter().map(|b| find_spends(b, watched)).collect();
        for ((block, height), block_spends) in blocks.iter().zip(&heights).zip(spends) {
            for (nf, txid) in block_spends {
                watch.record(nf, *height, txid, block.time);
            }
        }
    }
    Ok(hits)
}

/// Every action in this block that reveals a watched nullifier, in `vtx` order.
fn find_spends(
    block: &CompactBlock,
    watched: &HashMap<[u8; 32], NotePool>,
) -> Vec<([u8; 32], TxId)> {
    let mut out = Vec::new();
    for tx in &block.vtx {
        let lists = [
            (&tx.ironwood_actions, NotePool::Ironwood),
            (&tx.actions, NotePool::Orchard),
        ];
        for (actions, pool) in lists {
            for action in actions {
                let Ok(nf) = <[u8; 32]>::try_from(action.nullifier.as_slice()) else {
                    continue;
                };
                if watched.get(&nf) == Some(&pool) {
                    out.push((nf, tx.txid()));
                }
            }
        }
    }
    out
}

fn check_height(block: &CompactBlock) -> Result<u32, String> {
    u32::try_from(block.height).map_err(|_| format!("block height {} is absurd", block.height))
}

/// The notes in this compact transaction that decrypt to us, as nullifiers.
///
/// An empty answer means the transaction is not ours. Each pool is skipped outright when
/// the transaction carries no actions in it, so a transparent or Sapling-only
/// transaction costs two length checks and no allocation. The nullifier derivation runs
/// only for a note that decrypted, which is the envelope's own handful, never per action.
fn compact_tx_notes(
    tx: &CompactTx,
    ivks: &[PreparedIncomingViewingKey],
    fvk: &FullViewingKey,
) -> Vec<FoundNullifier> {
    let mut found = Vec::new();
    if !tx.actions.is_empty() {
        let orchard: Vec<(OrchardDomain, CompactAction)> = tx
            .actions
            .iter()
            .filter_map(|a| CompactAction::try_from(a).ok())
            .map(|a| (OrchardDomain::for_compact_action(&a), a))
            .collect();
        for ((note, _), _) in batch::try_compact_note_decryption(ivks, &orchard)
            .into_iter()
            .flatten()
        {
            found.push((note_nullifier(fvk, &note), NotePool::Orchard));
        }
    }

    // The Ironwood pass. Same actions shape, same keys, different domain: an Ironwood
    // note is a version 3 plaintext and only `IronwoodDomain` will read it.
    if !tx.ironwood_actions.is_empty() {
        let ironwood: Vec<(IronwoodDomain, CompactAction)> = tx
            .ironwood_actions
            .iter()
            .filter_map(|a| CompactAction::try_from(a).ok())
            .map(|a| (IronwoodDomain::for_compact_action(&a), a))
            .collect();
        for ((note, _), _) in batch::try_compact_note_decryption(ivks, &ironwood)
            .into_iter()
            .flatten()
        {
            found.push((note_nullifier(fvk, &note), NotePool::Ironwood));
        }
    }
    found
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
                nullifier: None,
                spent: None,
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
                nullifier: keys
                    .fvk
                    .as_ref()
                    .map(|fvk| note_nullifier(fvk, &out.note().0)),
                spent: None,
            });
        }
    }
    notes
}

/// Marks each note spent or not from what the block walk saw, and builds the result.
///
/// Every Orchard-family note fetched in full must have been watched by the compact
/// pass: both passes derive the nullifier from the same note with the same key. A note
/// that was not is refused rather than shown as unspent, because "unspent" would then
/// be an answer this scan never checked.
pub fn finish_open(
    mut notes: Vec<ReceivedNote>,
    watch: &SpendWatch,
    tip_height: u32,
    birthday: u32,
    birthday_defaulted: bool,
    scanned_blocks: u32,
    gateway: String,
) -> Result<OpenResult, String> {
    for note in &mut notes {
        let Some(nf) = note.nullifier else { continue };
        if !watch.is_watching(&nf) {
            return Err(format!(
                "note {} of transaction {} was found in full but not in the block walk, so \
                 whether it was spent is unknown",
                note.action_index, note.txid
            ));
        }
        note.spent = watch.spent_at(&nf).map(|(height, txid)| SpentAt {
            txid: txid.to_string(),
            height,
            time: watch.spent_time(&nf).unwrap_or(0),
        });
    }
    let (spent, unspent): (Vec<ReceivedNote>, Vec<ReceivedNote>) =
        notes.iter().cloned().partition(|n| n.spent.is_some());
    Ok(OpenResult {
        total_zat: total_zat(&unspent)?,
        spent_zat: total_zat(&spent)?,
        notes,
        tip_height,
        birthday,
        birthday_defaulted,
        scanned_blocks,
        gateway,
    })
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
            nullifier: None,
            spent: None,
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
        assert_eq!(
            scan_compact_blocks(&blocks, &keys, &mut SpendWatch::new()),
            Ok(Vec::new())
        );
    }

    #[test]
    fn a_run_of_blocks_reports_an_absurd_height() {
        let secret = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
        let keys = ViewKeys::from_secret(secret, Network::MainNetwork).unwrap();
        let blocks = vec![CompactBlock {
            height: u64::from(u32::MAX) + 1,
            ..Default::default()
        }];
        assert!(scan_compact_blocks(&blocks, &keys, &mut SpendWatch::new()).is_err());
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

    // ------------------------------------------------------------ spent detection

    mod spent {
        use super::*;
        use orchard::builder::{Builder, BundleType};
        use orchard::bundle::{BundleVersion, Flags};
        use orchard::keys::FullViewingKey;
        use orchard::note::ExtractedNoteCommitment;
        use orchard::tree::{MerkleHashOrchard, MerklePath};
        use orchard::value::NoteValue;
        use orchard::{Address, Anchor};
        use rand::rngs::OsRng;
        use zcash_client_backend::proto::compact_formats::{CompactOrchardAction, CompactTx};

        const SECRET: &str = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";

        fn keys() -> (ViewKeys, FullViewingKey) {
            let keys = ViewKeys::from_secret(SECRET, Network::MainNetwork).unwrap();
            let fvk = keys.fvk.clone().unwrap();
            (keys, fvk)
        }

        fn ironwood() -> (BundleVersion, Flags) {
            let v = BundleVersion::ironwood_v3();
            (v, v.default_flags())
        }

        /// The compact form of every action in a bundle, as lightwalletd serves it.
        fn compact_actions<T, V>(bundle: &orchard::Bundle<T, V>) -> Vec<CompactOrchardAction>
        where
            T: orchard::bundle::Authorization,
        {
            bundle
                .actions()
                .iter()
                .map(|a| CompactOrchardAction {
                    nullifier: a.nullifier().to_bytes().to_vec(),
                    cmx: a.cmx().to_bytes().to_vec(),
                    ephemeral_key: a.encrypted_note().epk_bytes.to_vec(),
                    ciphertext: a.encrypted_note().enc_ciphertext[..52].to_vec(),
                })
                .collect()
        }

        fn block(
            height: u64,
            txid: u8,
            ironwood_actions: Vec<CompactOrchardAction>,
        ) -> CompactBlock {
            CompactBlock {
                height,
                // A block time that is easy to tell apart from the height.
                time: 1_758_000_000 + height as u32,
                vtx: vec![CompactTx {
                    txid: vec![txid; 32],
                    ironwood_actions,
                    ..Default::default()
                }],
                ..Default::default()
            }
        }

        /// A synthetic Ironwood bundle paying `value` to `to`, unproven: the actions
        /// (commitment, nullifier, ciphertext) are all a scan ever sees.
        fn fund(
            to: Address,
            value: u64,
        ) -> orchard::Bundle<impl orchard::bundle::Authorization, i64> {
            let (v, flags) = ironwood();
            let mut b = Builder::new(BundleType::DEFAULT, v, flags, Anchor::empty_tree()).unwrap();
            b.add_output(None, to, NoteValue::from_raw(value), [0u8; 512])
                .unwrap();
            b.build::<i64>(OsRng).unwrap().unwrap().0
        }

        /// Spends `note` the way the sweep does, through orchard's builder with the
        /// envelope's `fvk`, and returns the nullifier the builder put on chain.
        fn sweep_nullifier(
            fvk: &FullViewingKey,
            note: orchard::Note,
        ) -> ([u8; 32], Vec<CompactOrchardAction>) {
            let cmx = ExtractedNoteCommitment::from(note.commitment());
            let path = MerklePath::from_parts(0, [MerkleHashOrchard::from_cmx(&cmx); 32]);
            let anchor = path.root(cmx);
            let (v, flags) = ironwood();
            let mut b = Builder::new(BundleType::DEFAULT, v, flags, anchor).unwrap();
            b.add_spend(fvk.clone(), note, path).unwrap();
            let (bundle, meta) = b.build::<i64>(OsRng).unwrap().unwrap();
            let at = meta.spend_action_index(0).unwrap();
            let nf = bundle.actions()[at].nullifier().to_bytes();
            (nf, compact_actions(&bundle))
        }

        /// The note the compact pass rebuilds from a funding bundle's 52-byte ciphertext.
        fn compact_note(keys: &ViewKeys, actions: &[CompactOrchardAction]) -> orchard::Note {
            let pairs: Vec<(IronwoodDomain, CompactAction)> = actions
                .iter()
                .filter_map(|a| CompactAction::try_from(a).ok())
                .map(|a| (IronwoodDomain::for_compact_action(&a), a))
                .collect();
            batch::try_compact_note_decryption(&keys.ivks, &pairs)
                .into_iter()
                .flatten()
                .map(|((note, _), _)| note)
                .next()
                .expect("the funding output decrypts with the envelope's key")
        }

        #[test]
        fn the_scan_derives_the_nullifier_the_sweep_reveals() {
            let (keys, fvk) = keys();
            let to = fvk.address_at(0u32, Scope::External);
            let funding = compact_actions(&fund(to, 130_000));

            // The note as the compact pass sees it: 52 bytes of plaintext and a rho.
            let note = compact_note(&keys, &funding);
            assert_eq!(note.value().inner(), 130_000);

            let (swept, _) = sweep_nullifier(&fvk, note);
            assert_eq!(note_nullifier(&fvk, &note), swept);

            // And the scan's own per-transaction answer carries that same nullifier.
            let tx = CompactTx {
                txid: vec![1; 32],
                ironwood_actions: funding,
                ..Default::default()
            };
            assert_eq!(
                compact_tx_notes(&tx, &keys.ivks, &fvk),
                vec![(swept, NotePool::Ironwood)]
            );
        }

        #[test]
        fn another_key_derives_a_different_nullifier() {
            let (keys, fvk) = keys();
            let note = compact_note(
                &keys,
                &compact_actions(&fund(fvk.address_at(0u32, Scope::External), 1)),
            );
            let other = ViewKeys::from_secret(
                "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
                Network::MainNetwork,
            )
            .unwrap()
            .fvk
            .unwrap();
            assert_ne!(note_nullifier(&fvk, &note), note_nullifier(&other, &note));
        }

        /// Funding in one block, the sweep two blocks later: the walk marks it spent.
        fn funded_then_swept() -> (ViewKeys, Vec<CompactBlock>, [u8; 32]) {
            let (keys, fvk) = keys();
            let funding = compact_actions(&fund(fvk.address_at(0u32, Scope::External), 130_000));
            let note = compact_note(&keys, &funding);
            let (nf, sweep_actions) = sweep_nullifier(&fvk, note);
            let blocks = vec![
                block(3_490_472, 1, funding),
                block(3_490_473, 7, Vec::new()),
                block(3_491_056, 2, sweep_actions),
            ];
            (keys, blocks, nf)
        }

        #[test]
        fn a_spend_in_the_same_chunk_is_seen() {
            let (keys, blocks, nf) = funded_then_swept();
            let mut watch = SpendWatch::new();
            let hits = scan_compact_blocks(&blocks, &keys, &mut watch).unwrap();
            assert_eq!(hits, vec![(3_490_472, TxId::from_bytes([1; 32]))]);
            assert!(watch.is_watching(&nf));
            assert_eq!(
                watch.spent_at(&nf),
                Some((3_491_056, TxId::from_bytes([2; 32])))
            );
            assert_eq!(watch.spent_time(&nf), Some(1_758_000_000 + 3_491_056));
        }

        #[test]
        fn a_spend_in_a_later_chunk_is_seen() {
            let (keys, blocks, nf) = funded_then_swept();
            let mut watch = SpendWatch::new();
            // One block per chunk: the funding chunk finds the note, the last one the spend.
            for b in blocks.chunks(1) {
                scan_compact_blocks(b, &keys, &mut watch).unwrap();
            }
            assert_eq!(
                watch.spent_at(&nf),
                Some((3_491_056, TxId::from_bytes([2; 32])))
            );
        }

        #[test]
        fn an_unswept_note_stays_unspent() {
            let (keys, blocks, nf) = funded_then_swept();
            let mut watch = SpendWatch::new();
            scan_compact_blocks(&blocks[..2], &keys, &mut watch).unwrap();
            assert!(watch.is_watching(&nf));
            assert_eq!(watch.spent_at(&nf), None);
        }

        #[test]
        fn the_nullifier_in_the_orchard_list_does_not_spend_an_ironwood_note() {
            let (keys, mut blocks, nf) = funded_then_swept();
            // Move the sweep's actions to the Orchard list: wrong pool, no match.
            let tx = &mut blocks[2].vtx[0];
            tx.actions = std::mem::take(&mut tx.ironwood_actions);
            let mut watch = SpendWatch::new();
            scan_compact_blocks(&blocks, &keys, &mut watch).unwrap();
            assert_eq!(watch.spent_at(&nf), None);
        }

        fn note(zat: u64, nf: u8) -> ReceivedNote {
            ReceivedNote {
                amount_zat: zat,
                memo: None,
                height: 3_490_472,
                txid: "aa".repeat(32),
                pool: "ironwood",
                action_index: 1,
                nullifier: Some([nf; 32]),
                spent: None,
            }
        }

        fn result(notes: Vec<ReceivedNote>, watch: &SpendWatch) -> Result<OpenResult, String> {
            finish_open(
                notes,
                watch,
                3_491_100,
                3_490_437,
                false,
                664,
                String::new(),
            )
        }

        #[test]
        fn totals_count_only_unspent_notes() {
            let mut watch = SpendWatch::new();
            watch.watch([1; 32], NotePool::Ironwood);
            watch.watch([2; 32], NotePool::Ironwood);
            watch.record([1; 32], 3_491_056, TxId::from_bytes([9; 32]), 1_758_500_000);

            let r = result(vec![note(130_000, 1), note(30_000, 2)], &watch).unwrap();
            assert_eq!(r.total_zat, 30_000);
            assert_eq!(r.spent_zat, 130_000);
            assert!(r.found());
            assert!(!r.all_spent());
            let at = r.notes[0].spent.as_ref().unwrap();
            assert_eq!(at.height, 3_491_056);
            assert_eq!(at.time, 1_758_500_000);
            assert_eq!(at.txid, TxId::from_bytes([9; 32]).to_string());
            assert_eq!(r.notes[1].spent, None);
        }

        #[test]
        fn all_spent_means_found_and_nothing_left() {
            let mut watch = SpendWatch::new();
            watch.watch([1; 32], NotePool::Ironwood);
            watch.record([1; 32], 3_491_056, TxId::from_bytes([9; 32]), 1_758_500_000);
            let r = result(vec![note(130_000, 1)], &watch).unwrap();
            assert!(r.found() && r.all_spent());
            assert_eq!(r.total_zat, 0);

            let empty = result(Vec::new(), &SpendWatch::new()).unwrap();
            assert!(!empty.found() && !empty.all_spent());
        }

        #[test]
        fn a_note_the_walk_never_watched_is_an_error_not_unspent() {
            assert!(result(vec![note(130_000, 1)], &SpendWatch::new()).is_err());
        }

        #[test]
        fn a_later_spend_does_not_overwrite_the_first() {
            let mut watch = SpendWatch::new();
            watch.watch([1; 32], NotePool::Ironwood);
            watch.record([1; 32], 10, TxId::from_bytes([2; 32]), 1_758_500_000);
            watch.record([1; 32], 11, TxId::from_bytes([3; 32]), 1_758_500_000);
            assert_eq!(
                watch.spent_at(&[1; 32]),
                Some((10, TxId::from_bytes([2; 32])))
            );
        }
    }
}
