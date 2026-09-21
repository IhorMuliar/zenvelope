//! Spending the envelope: addresses, fees, witnesses, keys and the proof.
//!
//! This module is the transport-free half of M3. Everything here is pure computation
//! over bytes and over protobuf structs someone else fetched, so it compiles everywhere
//! and is unit-tested natively. The network sequencing lives in [`crate::sweep`].
//!
//! # What a sweep is
//!
//! The envelope holds exactly one Ironwood note. Sweeping it means spending that note in
//! full: one Ironwood spend in, one output to the destination the recipient chose, and
//! one flat-fee output to Zenvelope. No change output, because there is nothing to keep:
//! `destination = note − network fee − flat fee`.
//!
//! # Why there is a Sapling prover here that cannot prove
//!
//! `zcash_primitives::transaction::builder::Builder::build` is generic over a Sapling
//! spend prover and a Sapling output prover, and wants a value of each. A Sapling bundle
//! is only built when the build configuration carries a `sapling_anchor`, and ours never
//! does, so the provers are never called. [`NoSaplingProver`] is the zero-sized witness
//! to that: it satisfies the type and aborts loudly if consensus of this file is ever
//! wrong. The alternative — the real `SpendParameters` — would mean shipping the 51.5 MB
//! Sapling proving parameters to a browser, which is exactly what D2 rules out.

use std::cmp::max;

use bip0039::{Count, English, Mnemonic};
use incrementalmerkletree::{frontier::CommitmentTree, witness::IncrementalWitness};
use orchard::keys::{FullViewingKey, OutgoingViewingKey, Scope, SpendAuthorizingKey};
use orchard::note::ExtractedNoteCommitment;
use orchard::tree::{MerkleHashOrchard, MerklePath};
use orchard::{Address as OrchardAddress, Anchor, Note};
use rand::rngs::OsRng;
use sapling_crypto::bundle::GrothProofBytes;
use sapling_crypto::prover::{OutputProver, SpendProver};
use transparent::address::TransparentAddress;
use transparent::builder::TransparentSigningSet;
use zcash_address::unified::{Container, Receiver};
use zcash_address::{ConversionError, TryFromAddress, ZcashAddress};
use zcash_client_backend::proto::compact_formats::CompactBlock;
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedSpendingKey};
use zcash_primitives::transaction::builder::{BuildConfig, Builder, BundlePadding};
use zcash_primitives::transaction::fees::zip317;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::{BlockHeight, Network, NetworkType, Parameters};
use zcash_protocol::memo::MemoBytes;
use zcash_protocol::value::Zatoshis;
use zip32::AccountId;

use crate::{decode_secret, SECRET_BYTES};

/// Ironwood shares Orchard's note commitment tree shape: depth 32.
pub const TREE_DEPTH: u8 = orchard::NOTE_COMMITMENT_TREE_DEPTH as u8;

/// The Ironwood note commitment tree as lightwalletd serves its frontier.
pub type IronwoodTree = CommitmentTree<MerkleHashOrchard, TREE_DEPTH>;

/// A witness for one Ironwood note, rolled forward as later commitments arrive.
pub type IronwoodWitness = IncrementalWitness<MerkleHashOrchard, TREE_DEPTH>;

/// ZIP-317's marginal fee, in zatoshi.
pub const MARGINAL_FEE_ZAT: u64 = 5_000;

/// ZIP-317's grace: the first two logical actions are free of marginal fee.
pub const GRACE_ACTIONS: u64 = 2;

/// The serialized size of a P2PKH transparent output, in bytes: 8 value + 1 script
/// length + 25 script. ZIP-317 counts transparent outputs by total serialized bytes.
pub const P2PKH_OUTPUT_BYTES: usize = 34;

/// The serialized size of a P2SH transparent output: 8 + 1 + 23.
pub const P2SH_OUTPUT_BYTES: usize = 32;

/// ZIP-317's standard P2PKH output size, the divisor for transparent logical actions.
pub const P2PKH_STANDARD_OUTPUT_SIZE: usize = 34;

/// An Orchard-family bundle is padded to at least this many actions.
pub const MIN_IRONWOOD_ACTIONS: usize = 2;

// ---------------------------------------------------------------------------
// Where a sweep can send
// ---------------------------------------------------------------------------

/// What an address the recipient pasted turns out to be.
///
/// The destination matrix for a sweep, in one type: a unified address carrying an Orchard
/// receiver takes the Ironwood note directly, a transparent address takes a transparent
/// output, and everything else is refused rather than silently downgraded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddressKind {
    /// Unified, with an Orchard receiver (unified typecode `0x03`). Receives Ironwood.
    UnifiedOrchard,
    /// Unified, but with no Orchard receiver. Nothing in this flow can pay it.
    UnifiedNoOrchard,
    /// A bare Sapling address, `zs1…`. Refused: see the module docs and D2.
    Sapling,
    /// A transparent address, `t1…` or `t3…`.
    Transparent,
    /// Not an address of this network at all.
    Invalid,
}

impl AddressKind {
    /// The string this kind crosses the JS boundary as.
    pub fn as_str(self) -> &'static str {
        match self {
            AddressKind::UnifiedOrchard => "unified_orchard",
            AddressKind::UnifiedNoOrchard => "unified_no_orchard",
            AddressKind::Sapling => "sapling",
            AddressKind::Transparent => "transparent",
            AddressKind::Invalid => "invalid",
        }
    }

    /// Whether a sweep can pay this kind of address.
    pub fn is_payable(self) -> bool {
        matches!(self, AddressKind::UnifiedOrchard | AddressKind::Transparent)
    }
}

/// The verdict on one pasted address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Classification {
    pub kind: AddressKind,
    /// Why a sweep will not pay it, or `None` when it will.
    pub reason: Option<String>,
}

/// An output a sweep can actually add to a transaction.
#[derive(Clone, Debug)]
pub enum SweepOutput {
    /// Paid as an Ironwood action to the address's Orchard receiver.
    Ironwood(Box<OrchardAddress>),
    /// Paid as a transparent output. The amount is public from here on.
    Transparent(TransparentAddress),
}

impl SweepOutput {
    /// The serialized byte size ZIP-317 charges for this output, or 0 when shielded.
    fn transparent_bytes(&self) -> usize {
        match self {
            SweepOutput::Ironwood(_) => 0,
            SweepOutput::Transparent(TransparentAddress::PublicKeyHash(_)) => P2PKH_OUTPUT_BYTES,
            SweepOutput::Transparent(TransparentAddress::ScriptHash(_)) => P2SH_OUTPUT_BYTES,
        }
    }
}

/// The shape a [`ZcashAddress`] is decoded into for classification.
enum AnyAddress {
    Unified(NetworkType, Vec<Receiver>),
    Sapling(NetworkType),
    Transparent(NetworkType, TransparentAddress),
    /// A ZIP-320 TEX address: transparent-only by construction, and not a plain t-addr.
    Tex(NetworkType),
}

impl TryFromAddress for AnyAddress {
    type Error = String;

    fn try_from_unified(
        net: NetworkType,
        data: zcash_address::unified::Address,
    ) -> Result<Self, ConversionError<Self::Error>> {
        Ok(AnyAddress::Unified(net, data.items()))
    }

    fn try_from_sapling(
        net: NetworkType,
        _data: [u8; 43],
    ) -> Result<Self, ConversionError<Self::Error>> {
        Ok(AnyAddress::Sapling(net))
    }

    fn try_from_transparent_p2pkh(
        net: NetworkType,
        data: [u8; 20],
    ) -> Result<Self, ConversionError<Self::Error>> {
        Ok(AnyAddress::Transparent(
            net,
            TransparentAddress::PublicKeyHash(data),
        ))
    }

    fn try_from_transparent_p2sh(
        net: NetworkType,
        data: [u8; 20],
    ) -> Result<Self, ConversionError<Self::Error>> {
        Ok(AnyAddress::Transparent(
            net,
            TransparentAddress::ScriptHash(data),
        ))
    }

    fn try_from_tex(
        net: NetworkType,
        _data: [u8; 20],
    ) -> Result<Self, ConversionError<Self::Error>> {
        Ok(AnyAddress::Tex(net))
    }
}

/// Classifies a pasted address against the network the sweep runs on.
///
/// Never throws: an unparseable string, a testnet address on mainnet and a Sprout address
/// all come back as a kind plus a reason the recipient can read.
pub fn classify_address(address: &str, network: Network) -> Classification {
    let want = network.network_type();
    let trimmed = address.trim();

    let parsed = match ZcashAddress::try_from_encoded(trimmed) {
        Ok(p) => p,
        Err(e) => {
            return Classification {
                kind: AddressKind::Invalid,
                reason: Some(format!("not a Zcash address: {e}")),
            }
        }
    };

    let decoded: AnyAddress = match parsed.convert::<AnyAddress>() {
        Ok(d) => d,
        Err(e) => {
            let reason: String = match e {
                ConversionError::User(msg) => msg,
                other => other.to_string(),
            };
            return Classification {
                kind: AddressKind::Invalid,
                reason: Some(reason),
            };
        }
    };

    let (net, kind, reason) = match decoded {
        AnyAddress::Unified(net, receivers) => {
            if receivers.iter().any(|r| matches!(r, Receiver::Orchard(_))) {
                (net, AddressKind::UnifiedOrchard, None)
            } else {
                (
                    net,
                    AddressKind::UnifiedNoOrchard,
                    Some(
                        "this unified address has no Orchard receiver, so it cannot \
                         receive an Ironwood note"
                            .to_string(),
                    ),
                )
            }
        }
        AnyAddress::Sapling(net) => (
            net,
            AddressKind::Sapling,
            Some(
                "Sapling addresses are not supported: Zenvelope proves Ironwood only, and \
                 paying Sapling would need the 51.5 MB Sapling proving parameters"
                    .to_string(),
            ),
        ),
        AnyAddress::Transparent(net, _) => (net, AddressKind::Transparent, None),
        AnyAddress::Tex(net) => (
            net,
            AddressKind::Invalid,
            Some("TEX addresses are not supported".to_string()),
        ),
    };

    if net != want {
        return Classification {
            kind: AddressKind::Invalid,
            reason: Some(format!(
                "this is a {net:?} address and the sweep is running on {want:?}"
            )),
        };
    }

    Classification { kind, reason }
}

/// Turns a pasted address into the output a sweep can add, or explains why it cannot.
pub fn resolve_output(address: &str, network: Network) -> Result<SweepOutput, String> {
    let verdict = classify_address(address, network);
    if !verdict.kind.is_payable() {
        return Err(verdict
            .reason
            .unwrap_or_else(|| format!("{address:?} is not an address a sweep can pay")));
    }

    let decoded = ZcashAddress::try_from_encoded(address.trim())
        .map_err(|e| format!("not a Zcash address: {e}"))?
        .convert::<AnyAddress>()
        .map_err(|e: ConversionError<String>| e.to_string())?;

    match decoded {
        AnyAddress::Unified(_, receivers) => {
            let raw = receivers
                .iter()
                .find_map(|r| match r {
                    Receiver::Orchard(bytes) => Some(*bytes),
                    _ => None,
                })
                .ok_or("this unified address has no Orchard receiver")?;
            let addr = Option::<OrchardAddress>::from(OrchardAddress::from_raw_address_bytes(&raw))
                .ok_or("the Orchard receiver in this unified address is not a valid address")?;
            Ok(SweepOutput::Ironwood(Box::new(addr)))
        }
        AnyAddress::Transparent(_, t) => Ok(SweepOutput::Transparent(t)),
        AnyAddress::Sapling(_) | AnyAddress::Tex(_) => Err(
            "a sweep can only pay a unified address with an Orchard receiver, or a \
                 transparent address"
                .to_string(),
        ),
    }
}

// ---------------------------------------------------------------------------
// Fee arithmetic
// ---------------------------------------------------------------------------

/// The ZIP-317 network fee for a sweep with these outputs, in zatoshi.
///
/// A sweep has exactly one Ironwood spend. The Ironwood pool permits cross-address
/// transfers, so a spend and an output share an action and the requested action count is
/// `max(spends, outputs)`, padded up to the 2-action minimum. Transparent outputs are
/// charged by total serialized bytes over ZIP-317's standard P2PKH output size.
///
/// The three shapes a sweep actually takes:
///
/// | outputs                              | actions            | fee    |
/// |--------------------------------------|--------------------|--------|
/// | 1 shielded (no flat fee)             | 2 ironwood         | 10,000 |
/// | 2 shielded (destination + flat fee)  | 2 ironwood         | 10,000 |
/// | 1 shielded + 1 transparent           | 2 ironwood + 1 t   | 15,000 |
pub fn network_fee_zat(outputs: &[SweepOutput]) -> u64 {
    let ironwood_outputs = outputs
        .iter()
        .filter(|o| matches!(o, SweepOutput::Ironwood(_)))
        .count();
    let transparent_bytes: usize = outputs.iter().map(SweepOutput::transparent_bytes).sum();

    let ironwood_actions = max(max(1, ironwood_outputs), MIN_IRONWOOD_ACTIONS) as u64;
    let transparent_actions = transparent_bytes.div_ceil(P2PKH_STANDARD_OUTPUT_SIZE) as u64;

    MARGINAL_FEE_ZAT * max(GRACE_ACTIONS, transparent_actions + ironwood_actions)
}

/// How the note's value is split between the destination, Zenvelope and the miner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SweepAmounts {
    pub amount_to_destination_zat: u64,
    pub fee_zat: u64,
    pub network_fee_zat: u64,
}

/// Splits a note's value across the sweep's outputs, refusing to build a sweep that
/// cannot pay for itself.
pub fn plan_amounts(
    note_value_zat: u64,
    fee_zat: u64,
    outputs: &[SweepOutput],
) -> Result<SweepAmounts, String> {
    let network_fee = network_fee_zat(outputs);
    let overhead = network_fee
        .checked_add(fee_zat)
        .ok_or("the network fee plus the flat fee overflows")?;

    let amount = note_value_zat
        .checked_sub(overhead)
        .filter(|a| *a > 0)
        .ok_or_else(|| {
            format!(
                "this envelope holds {note_value_zat} zatoshi, which does not cover the \
             {network_fee} zatoshi network fee plus the {fee_zat} zatoshi Zenvelope fee; \
             there would be nothing left to send"
            )
        })?;

    Ok(SweepAmounts {
        amount_to_destination_zat: amount,
        fee_zat,
        network_fee_zat: network_fee,
    })
}

// ---------------------------------------------------------------------------
// The Sapling prover that never proves
// ---------------------------------------------------------------------------

/// A Sapling prover that cannot prove, for a builder that never asks it to.
///
/// See the module docs. Every method is unreachable as long as the build configuration
/// carries `sapling_anchor: None`, which is the invariant the whole of M3 rests on.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoSaplingProver;

/// The message every [`NoSaplingProver`] method aborts with.
pub const NO_SAPLING_PROVER_MESSAGE: &str =
    "Zenvelope never builds a Sapling bundle: BuildConfig::Standard always carries \
     sapling_anchor: None";

impl SpendProver for NoSaplingProver {
    type Proof = GrothProofBytes;

    fn prepare_circuit(
        _proof_generation_key: sapling_crypto::ProofGenerationKey,
        _diversifier: sapling_crypto::Diversifier,
        _rseed: sapling_crypto::Rseed,
        _value: sapling_crypto::value::NoteValue,
        _alpha: jubjub::Fr,
        _rcv: sapling_crypto::value::ValueCommitTrapdoor,
        _anchor: bls12_381::Scalar,
        _merkle_path: sapling_crypto::MerklePath,
    ) -> Option<sapling_crypto::circuit::Spend> {
        unreachable!("{NO_SAPLING_PROVER_MESSAGE}")
    }

    fn create_proof<R: rand_core::RngCore>(
        &self,
        _circuit: sapling_crypto::circuit::Spend,
        _rng: &mut R,
    ) -> Self::Proof {
        unreachable!("{NO_SAPLING_PROVER_MESSAGE}")
    }

    fn encode_proof(_proof: Self::Proof) -> GrothProofBytes {
        unreachable!("{NO_SAPLING_PROVER_MESSAGE}")
    }
}

impl OutputProver for NoSaplingProver {
    type Proof = GrothProofBytes;

    fn prepare_circuit(
        _esk: &sapling_crypto::keys::EphemeralSecretKey,
        _payment_address: sapling_crypto::PaymentAddress,
        _rcm: jubjub::Fr,
        _value: sapling_crypto::value::NoteValue,
        _rcv: sapling_crypto::value::ValueCommitTrapdoor,
    ) -> sapling_crypto::circuit::Output {
        unreachable!("{NO_SAPLING_PROVER_MESSAGE}")
    }

    fn create_proof<R: rand_core::RngCore>(
        &self,
        _circuit: sapling_crypto::circuit::Output,
        _rng: &mut R,
    ) -> Self::Proof {
        unreachable!("{NO_SAPLING_PROVER_MESSAGE}")
    }

    fn encode_proof(_proof: Self::Proof) -> GrothProofBytes {
        unreachable!("{NO_SAPLING_PROVER_MESSAGE}")
    }
}

// ---------------------------------------------------------------------------
// A fresh in-browser wallet
// ---------------------------------------------------------------------------

/// A wallet the recipient can sweep into and then import into a real Zcash wallet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GeneratedWallet {
    /// 24 English BIP-39 words.
    pub mnemonic: String,
    /// The unified address the sweep pays. Always carries an Orchard receiver.
    pub address: String,
    pub ufvk: String,
    /// The block height to start scanning from when this wallet is imported.
    pub birthday: u32,
}

/// Derives a wallet from fixed BIP-39 entropy.
///
/// The seed is `mnemonic.to_seed("")`, the full 64 bytes, with an empty passphrase. That
/// is what Zodl (formerly Zashi) and `zcash-devtool` do, so the mnemonic this produces
/// can be typed into either of them and the same account 0 comes back.
pub fn wallet_from_entropy(
    entropy: &[u8; SECRET_BYTES],
    network: Network,
    birthday: u32,
) -> Result<GeneratedWallet, String> {
    let mnemonic = Mnemonic::<English>::from_entropy(entropy.to_vec())
        .map_err(|e| format!("could not build a mnemonic from 32 bytes of entropy: {e}"))?;
    wallet_from_mnemonic(mnemonic.phrase(), network, birthday)
}

/// Derives a wallet from an existing 24-word mnemonic.
pub fn wallet_from_mnemonic(
    phrase: &str,
    network: Network,
    birthday: u32,
) -> Result<GeneratedWallet, String> {
    let mnemonic = Mnemonic::<English>::from_phrase(phrase.to_string())
        .map_err(|e| format!("not a valid BIP-39 English mnemonic: {e}"))?;
    let seed = mnemonic.to_seed("");

    let usk = UnifiedSpendingKey::from_seed(&network, &seed, AccountId::ZERO)
        .map_err(|e| format!("could not derive a spending key from the seed: {e:?}"))?;
    let ufvk = usk.to_unified_full_viewing_key();

    // SHIELDED allows Orchard and Sapling and omits transparent: the address grows a
    // Sapling receiver when the build carries Sapling key material and stays Orchard-only
    // when it does not, and either way it can receive the Ironwood note.
    let (address, _) = ufvk
        .default_address(UnifiedAddressRequest::SHIELDED)
        .map_err(|e| format!("could not derive a unified address: {e:?}"))?;

    Ok(GeneratedWallet {
        mnemonic: mnemonic.phrase().to_string(),
        address: address.encode(&network),
        ufvk: ufvk.encode(&network),
        birthday,
    })
}

/// Generates a fresh 24-word wallet from the platform CSPRNG.
pub fn new_wallet(network: Network, birthday: u32) -> Result<GeneratedWallet, String> {
    // 256 bits of entropy is what makes a 24-word mnemonic; `Count::Words24` says the
    // same thing to any reader who knows BIP-39 but not that arithmetic.
    debug_assert_eq!(Count::Words24.entropy_bit_length(), SECRET_BYTES * 8);
    let mut entropy = [0u8; SECRET_BYTES];
    getrandom::fill(&mut entropy).map_err(|e| format!("CSPRNG unavailable: {e}"))?;
    wallet_from_entropy(&entropy, network, birthday)
}

// ---------------------------------------------------------------------------
// The witness
// ---------------------------------------------------------------------------

/// Parses a 32-byte note commitment into a tree node.
pub fn cmx_node(cmx: &[u8]) -> Result<MerkleHashOrchard, String> {
    let bytes: [u8; 32] = cmx
        .try_into()
        .map_err(|_| format!("a note commitment is {} bytes, want 32", cmx.len()))?;
    let cmx = Option::<ExtractedNoteCommitment>::from(ExtractedNoteCommitment::from_bytes(&bytes))
        .ok_or("a note commitment is not a valid Pallas base field element")?;
    Ok(MerkleHashOrchard::from_cmx(&cmx))
}

/// Renders a tree node as hex, for comparing roots against `GetTreeState`.
pub fn node_hex(node: &MerkleHashOrchard) -> String {
    hex::encode(node.to_bytes())
}

/// Replays Ironwood note commitments into a tree, taking a witness on the way past.
///
/// Start from the frontier `GetTreeState(h − 1).ironwood_tree()` gives, then feed it every
/// block from `h` onward in order. Inside a block, commitments are appended in (tx index,
/// action index) order, which is the order the chain itself commits them in. The witness
/// is taken immediately after the target commitment is appended, so it witnesses that
/// leaf; every later commitment is then appended to the witness as well as to the tree.
pub struct WitnessScan {
    tree: IronwoodTree,
    witness: Option<IronwoodWitness>,
    /// How many commitments have been appended since the scan started.
    appended: usize,
}

impl WitnessScan {
    /// Starts a replay from a frontier.
    pub fn new(tree: IronwoodTree) -> Self {
        Self {
            tree,
            witness: None,
            appended: 0,
        }
    }

    /// Appends every Ironwood commitment in one block.
    ///
    /// `target` is `(txid in protocol byte order, index into that tx's ironwood_actions)`;
    /// pass it for the block holding the note and `None` for every later block.
    pub fn append_block(
        &mut self,
        block: &CompactBlock,
        target: Option<(&[u8], usize)>,
    ) -> Result<(), String> {
        for tx in &block.vtx {
            let ours = target.filter(|(txid, _)| tx.txid == *txid);
            for (i, action) in tx.ironwood_actions.iter().enumerate() {
                let leaf = cmx_node(&action.cmx)?;
                self.tree
                    .append(leaf)
                    .map_err(|_| "the Ironwood note commitment tree is full".to_string())?;
                self.appended += 1;

                // Every witness already taken must see this leaf too — except the one
                // that is about to be created from it.
                if let Some(w) = self.witness.as_mut() {
                    w.append(leaf)
                        .map_err(|_| "the Ironwood witness is full".to_string())?;
                }

                if ours.map(|(_, idx)| idx == i).unwrap_or(false) {
                    if self.witness.is_some() {
                        return Err("the note was witnessed twice".to_string());
                    }
                    self.witness = Some(
                        IronwoodWitness::from_tree(self.tree.clone())
                            .ok_or("cannot witness a leaf in an empty tree")?,
                    );
                }
            }
        }
        Ok(())
    }

    /// The root of the replayed tree, as hex.
    pub fn tree_root_hex(&self) -> String {
        node_hex(&self.tree.root())
    }

    /// How many commitments the replay has appended.
    pub fn appended(&self) -> usize {
        self.appended
    }

    /// The position the witnessed note sits at in the tree.
    pub fn position(&self) -> Option<u64> {
        self.witness
            .as_ref()
            .map(|w| u64::from(w.witnessed_position()))
    }

    /// The witness root, as hex. This is the anchor the sweep will use.
    pub fn witness_root_hex(&self) -> Option<String> {
        self.witness.as_ref().map(|w| node_hex(&w.root()))
    }

    /// Finishes the replay into the Merkle path and anchor a spend needs.
    ///
    /// `server_root_hex` is the root `GetTreeState(anchor height)` reports. A mismatch is
    /// a hard error: it means the replay saw a different set of commitments than the
    /// chain did, and any proof built on it would be rejected. There is no fallback,
    /// because a wrong anchor is not a degraded sweep, it is a lost one.
    pub fn finish(self, server_root_hex: &str) -> Result<(MerklePath, Anchor), String> {
        let witness = self
            .witness
            .ok_or("the envelope's note commitment was never seen while replaying the chain")?;

        let root = node_hex(&witness.root());
        let tree_root = node_hex(&self.tree.root());
        if tree_root != server_root_hex {
            return Err(format!(
                "the replayed Ironwood tree root {tree_root} does not match the server's \
                 {server_root_hex}; refusing to build a proof against an anchor the chain \
                 does not have"
            ));
        }
        if root != server_root_hex {
            return Err(format!(
                "the witness root {root} does not match the server's {server_root_hex}"
            ));
        }

        let path = MerklePath::from(witness.path().ok_or("the witness has no auth path")?);
        Ok((path, Anchor::from(witness.root())))
    }
}

// ---------------------------------------------------------------------------
// Building and proving
// ---------------------------------------------------------------------------

/// The Orchard keys a sweep spends with, derived from the link secret.
pub struct SpendKeys {
    pub fvk: FullViewingKey,
    pub ask: SpendAuthorizingKey,
    pub ovk: OutgoingViewingKey,
}

/// Derives the Orchard spending material for a link secret.
///
/// Same ZIP-32 path as `derive()`: the 32-byte secret is the seed, account 0.
pub fn spend_keys_from_secret(secret_b64url: &str, network: Network) -> Result<SpendKeys, String> {
    let seed = decode_secret(secret_b64url)?;
    let usk = UnifiedSpendingKey::from_seed(&network, &seed, AccountId::ZERO)
        .map_err(|e| format!("could not derive spending key from secret: {e:?}"))?;
    let sk = usk.orchard();
    let fvk = FullViewingKey::from(sk);
    Ok(SpendKeys {
        ask: SpendAuthorizingKey::from(sk),
        ovk: fvk.to_ovk(Scope::External),
        fvk,
    })
}

/// Everything the builder needs, once the network work is done.
pub struct SweepPlan {
    pub network: Network,
    /// The height the transaction targets; its expiry is derived from this.
    pub target_height: u32,
    pub anchor: Anchor,
    pub keys: SpendKeys,
    pub note: Note,
    pub merkle_path: MerklePath,
    /// Destination first, then the flat fee output if there is one.
    pub outputs: Vec<(SweepOutput, u64, MemoBytes)>,
}

/// Builds, proves and signs the sweep.
///
/// This is the expensive call: the Orchard/Ironwood proof is created inside
/// `Builder::build`, using the proving key cached in `zcash_primitives`. Warm that cache
/// first (see `warm_proving_key`) or this call pays for building it too.
pub fn build_and_prove(plan: SweepPlan) -> Result<(Transaction, Vec<u8>), String> {
    let target_height = BlockHeight::from_u32(plan.target_height);

    let mut builder = Builder::new(
        plan.network,
        target_height,
        BuildConfig::Standard {
            // No Sapling bundle, ever: this `None` is what makes `NoSaplingProver` sound.
            sapling_anchor: None,
            // No Orchard bundle either. ZIP 258 forbids new value entering the Orchard
            // pool after NU6.3, so an envelope can only ever hold an Ironwood note.
            orchard_anchor: None,
            ironwood_anchor: Some(plan.anchor),
            orchard_padding: BundlePadding::DEFAULT,
            ironwood_padding: BundlePadding::DEFAULT,
        },
    );

    builder
        .add_ironwood_spend::<zip317::FeeError>(plan.keys.fvk.clone(), plan.note, plan.merkle_path)
        .map_err(|e| format!("could not add the envelope's note as a spend: {e}"))?;

    for (output, amount_zat, memo) in plan.outputs {
        let value = Zatoshis::from_u64(amount_zat)
            .map_err(|_| format!("output amount {amount_zat} zatoshi is out of range"))?;
        match output {
            SweepOutput::Ironwood(addr) => builder
                .add_ironwood_output::<zip317::FeeError>(
                    Some(plan.keys.ovk.clone()),
                    *addr,
                    value,
                    memo,
                )
                .map_err(|e| format!("could not add a shielded output: {e}"))?,
            SweepOutput::Transparent(addr) => builder
                .add_transparent_output(&addr, value)
                .map_err(|e| format!("could not add a transparent output: {e}"))?,
        }
    }

    let fee_rule = zip317::FeeRule::standard();
    let result = builder
        .build(
            &TransparentSigningSet::default(),
            &[],
            &[plan.keys.ask],
            OsRng,
            &NoSaplingProver,
            &NoSaplingProver,
            &fee_rule,
        )
        .map_err(|e| format!("could not build the sweep transaction: {e}"))?;

    let tx = result.transaction().clone();
    let mut raw = Vec::new();
    tx.write(&mut raw)
        .map_err(|e| format!("could not serialize the sweep transaction: {e}"))?;
    Ok((tx, raw))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::derive_from_secret;
    use incrementalmerkletree::Hashable;
    use zcash_address::unified::Encoding;
    use zcash_address::ToAddress;

    /// The fixed mnemonic vector, recorded in TEST_VECTORS.md so a Zodl import of the
    /// same words can be compared against it by hand.
    pub const VECTOR_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon \
abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
abandon abandon abandon abandon abandon abandon art";

    fn vector_secret() -> String {
        let bytes: [u8; SECRET_BYTES] = core::array::from_fn(|i| (i + 1) as u8);
        crate::encode_secret(&bytes)
    }

    fn envelope_address() -> String {
        derive_from_secret(&vector_secret(), Network::MainNetwork)
            .unwrap()
            .address
    }

    // --- address classification ------------------------------------------------

    #[test]
    fn an_envelope_address_is_unified_with_orchard() {
        let verdict = classify_address(&envelope_address(), Network::MainNetwork);
        assert_eq!(verdict.kind, AddressKind::UnifiedOrchard);
        assert_eq!(verdict.reason, None);
        assert!(verdict.kind.is_payable());
    }

    #[test]
    fn a_generated_wallet_address_is_payable() {
        let wallet =
            wallet_from_mnemonic(VECTOR_MNEMONIC, Network::MainNetwork, 3_490_472).unwrap();
        let verdict = classify_address(&wallet.address, Network::MainNetwork);
        assert_eq!(verdict.kind, AddressKind::UnifiedOrchard, "{verdict:?}");
        assert!(resolve_output(&wallet.address, Network::MainNetwork).is_ok());
    }

    #[test]
    fn a_transparent_address_is_transparent() {
        // A mainnet P2PKH address, all-zero hash, encoded by zcash_address itself.
        let t = ZcashAddress::from_transparent_p2pkh(NetworkType::Main, [0u8; 20]).to_string();
        let verdict = classify_address(&t, Network::MainNetwork);
        assert_eq!(verdict.kind, AddressKind::Transparent, "{t}");
        assert!(t.starts_with("t1"), "{t}");
        assert!(matches!(
            resolve_output(&t, Network::MainNetwork).unwrap(),
            SweepOutput::Transparent(TransparentAddress::PublicKeyHash(_))
        ));
    }

    #[test]
    fn a_sapling_address_is_refused_with_a_reason() {
        let zs = ZcashAddress::from_sapling(NetworkType::Main, [0u8; 43]).to_string();
        let verdict = classify_address(&zs, Network::MainNetwork);
        assert_eq!(verdict.kind, AddressKind::Sapling, "{zs}");
        assert!(zs.starts_with("zs1"), "{zs}");
        assert!(verdict.reason.unwrap().contains("Sapling"));
        assert!(resolve_output(&zs, Network::MainNetwork).is_err());
    }

    #[test]
    fn a_wrong_network_address_is_invalid() {
        let testnet = derive_from_secret(&vector_secret(), Network::TestNetwork)
            .unwrap()
            .address;
        let verdict = classify_address(&testnet, Network::MainNetwork);
        assert_eq!(verdict.kind, AddressKind::Invalid);
        assert!(verdict.reason.unwrap().contains("Test"));
    }

    #[test]
    fn nonsense_is_invalid_and_never_panics() {
        for s in ["", "   ", "u1", "not-an-address", "zcash:u1abc", "1BvBMSEY"] {
            let verdict = classify_address(s, Network::MainNetwork);
            assert_eq!(verdict.kind, AddressKind::Invalid, "{s:?}");
            assert!(verdict.reason.is_some(), "{s:?}");
            assert!(resolve_output(s, Network::MainNetwork).is_err(), "{s:?}");
        }
    }

    #[test]
    fn a_unified_address_without_orchard_is_named_as_such() {
        // A unified address carrying only a Sapling receiver: decodable, but nothing a
        // sweep can pay.
        let ua =
            zcash_address::unified::Address::try_from_items(vec![Receiver::Sapling([0u8; 43])])
                .expect("a Sapling-only unified address is well-formed");
        let encoded = ZcashAddress::from_unified(NetworkType::Main, ua).to_string();
        let verdict = classify_address(&encoded, Network::MainNetwork);
        assert_eq!(verdict.kind, AddressKind::UnifiedNoOrchard);
        assert!(verdict.reason.unwrap().contains("Orchard receiver"));
        assert!(!verdict.kind.is_payable());
    }

    #[test]
    fn kind_strings_are_the_documented_ones() {
        assert_eq!(AddressKind::UnifiedOrchard.as_str(), "unified_orchard");
        assert_eq!(AddressKind::UnifiedNoOrchard.as_str(), "unified_no_orchard");
        assert_eq!(AddressKind::Sapling.as_str(), "sapling");
        assert_eq!(AddressKind::Transparent.as_str(), "transparent");
        assert_eq!(AddressKind::Invalid.as_str(), "invalid");
    }

    // --- fee arithmetic --------------------------------------------------------

    fn shielded() -> SweepOutput {
        let addr = resolve_output(&envelope_address(), Network::MainNetwork).unwrap();
        assert!(matches!(addr, SweepOutput::Ironwood(_)));
        addr
    }

    fn transparent_p2pkh() -> SweepOutput {
        SweepOutput::Transparent(TransparentAddress::PublicKeyHash([0u8; 20]))
    }

    #[test]
    fn two_shielded_outputs_cost_ten_thousand() {
        assert_eq!(network_fee_zat(&[shielded(), shielded()]), 10_000);
    }

    #[test]
    fn one_shielded_output_still_costs_ten_thousand() {
        // The bundle is padded up to the 2-action minimum, and ZIP-317's grace is 2
        // actions, so a one-output sweep is not cheaper.
        assert_eq!(network_fee_zat(&[shielded()]), 10_000);
    }

    #[test]
    fn a_transparent_output_costs_five_thousand_more() {
        assert_eq!(network_fee_zat(&[shielded(), transparent_p2pkh()]), 15_000);
        assert_eq!(network_fee_zat(&[transparent_p2pkh()]), 15_000);
    }

    #[test]
    fn a_p2sh_output_is_charged_as_one_action() {
        let p2sh = SweepOutput::Transparent(TransparentAddress::ScriptHash([0u8; 20]));
        assert_eq!(network_fee_zat(&[shielded(), p2sh]), 15_000);
    }

    #[test]
    fn the_m1_note_splits_as_expected() {
        // The real M1 envelope: 130,000 zatoshi, a 30,000 zatoshi flat fee, two shielded
        // outputs. 130,000 − 10,000 − 30,000 = 90,000 to the destination.
        let plan = plan_amounts(130_000, 30_000, &[shielded(), shielded()]).unwrap();
        assert_eq!(
            plan,
            SweepAmounts {
                amount_to_destination_zat: 90_000,
                fee_zat: 30_000,
                network_fee_zat: 10_000,
            }
        );
        assert_eq!(
            plan.amount_to_destination_zat + plan.fee_zat + plan.network_fee_zat,
            130_000
        );
    }

    #[test]
    fn a_zero_flat_fee_means_one_output() {
        let plan = plan_amounts(130_000, 0, &[shielded()]).unwrap();
        assert_eq!(plan.amount_to_destination_zat, 120_000);
        assert_eq!(plan.fee_zat, 0);
        assert_eq!(plan.network_fee_zat, 10_000);
    }

    #[test]
    fn a_note_that_cannot_pay_for_itself_is_refused() {
        // Exactly the overhead leaves nothing to send, which is not a sweep.
        let err = plan_amounts(40_000, 30_000, &[shielded(), shielded()]).unwrap_err();
        assert!(err.contains("nothing left to send"), "{err}");
        assert!(plan_amounts(39_999, 30_000, &[shielded(), shielded()]).is_err());
        assert!(plan_amounts(0, 0, &[shielded()]).is_err());
        // One zatoshi over the line is a sweep, just a small one.
        assert_eq!(
            plan_amounts(40_001, 30_000, &[shielded(), shielded()])
                .unwrap()
                .amount_to_destination_zat,
            1
        );
    }

    #[test]
    fn overflowing_fees_are_refused_rather_than_wrapped() {
        assert!(plan_amounts(u64::MAX, u64::MAX, &[shielded()]).is_err());
    }

    // --- the prover that never proves ------------------------------------------

    #[test]
    fn the_no_sapling_prover_aborts_if_it_is_ever_reached() {
        let caught =
            std::panic::catch_unwind(|| <NoSaplingProver as SpendProver>::encode_proof([0u8; 192]));
        assert!(caught.is_err(), "the spend prover should be unreachable");

        let caught = std::panic::catch_unwind(|| {
            <NoSaplingProver as OutputProver>::encode_proof([0u8; 192])
        });
        assert!(caught.is_err(), "the output prover should be unreachable");
    }

    #[test]
    fn the_no_sapling_prover_is_zero_sized() {
        // It exists to satisfy a type parameter and must cost the wasm nothing.
        assert_eq!(core::mem::size_of::<NoSaplingProver>(), 0);
    }

    // --- mnemonic to unified address -------------------------------------------

    #[test]
    fn the_mnemonic_vector_derives_deterministically() {
        let a = wallet_from_mnemonic(VECTOR_MNEMONIC, Network::MainNetwork, 3_490_472).unwrap();
        let b = wallet_from_mnemonic(VECTOR_MNEMONIC, Network::MainNetwork, 3_490_472).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.mnemonic, VECTOR_MNEMONIC);
        assert_eq!(a.mnemonic.split_whitespace().count(), 24);
        assert!(a.address.starts_with("u1"), "{}", a.address);
        assert!(a.ufvk.starts_with("uview1"), "{}", a.ufvk);
        assert_eq!(a.birthday, 3_490_472);
    }

    /// The recorded vector. If this ever changes, a wallet imported from these words is
    /// no longer the wallet Zenvelope swept into, so the change must be deliberate.
    #[test]
    fn the_mnemonic_vector_matches_test_vectors_md() {
        let wallet = wallet_from_mnemonic(VECTOR_MNEMONIC, Network::MainNetwork, 0).unwrap();
        let recorded = include_str!("../TEST_VECTORS.md");
        assert!(
            recorded.contains(&wallet.address),
            "TEST_VECTORS.md does not record the unified address {} for the fixed \
             mnemonic; regenerate it with `cargo test -p zenvelope-core -- --ignored \
             --nocapture print_test_vectors`",
            wallet.address
        );
    }

    #[test]
    fn entropy_and_mnemonic_agree() {
        // 32 zero bytes are the "abandon … art" vector's entropy.
        let from_entropy =
            wallet_from_entropy(&[0u8; SECRET_BYTES], Network::MainNetwork, 7).unwrap();
        assert_eq!(from_entropy.mnemonic, VECTOR_MNEMONIC);
        let from_phrase = wallet_from_mnemonic(VECTOR_MNEMONIC, Network::MainNetwork, 7).unwrap();
        assert_eq!(from_entropy, from_phrase);
    }

    #[test]
    fn a_seed_is_sixty_four_bytes_with_an_empty_passphrase() {
        let mnemonic = Mnemonic::<English>::from_phrase(VECTOR_MNEMONIC.to_string()).unwrap();
        let seed = mnemonic.to_seed("");
        assert_eq!(seed.len(), 64);
        // PBKDF2-HMAC-SHA512("abandon … art", "mnemonic", 2048) — the BIP-39 seed for
        // the 24-word all-zero-entropy vector with an empty passphrase. An empty
        // passphrase is the choice Zodl and zcash-devtool make, and it is what makes
        // these words importable into either of them.
        assert_eq!(
            hex::encode(seed),
            "408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf70\
             5489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840"
        );
    }

    #[test]
    fn networks_give_different_wallets() {
        let main = wallet_from_mnemonic(VECTOR_MNEMONIC, Network::MainNetwork, 0).unwrap();
        let test = wallet_from_mnemonic(VECTOR_MNEMONIC, Network::TestNetwork, 0).unwrap();
        assert_ne!(main.address, test.address);
        assert!(test.address.starts_with("utest1"), "{}", test.address);
    }

    #[test]
    fn a_bad_mnemonic_is_rejected() {
        assert!(wallet_from_mnemonic("not a mnemonic", Network::MainNetwork, 0).is_err());
        assert!(wallet_from_mnemonic("", Network::MainNetwork, 0).is_err());
        // Right words, wrong checksum.
        let bad = VECTOR_MNEMONIC.replace(" art", " abandon");
        assert!(wallet_from_mnemonic(&bad, Network::MainNetwork, 0).is_err());
    }

    #[test]
    fn generated_wallets_differ() {
        let a = new_wallet(Network::MainNetwork, 1).unwrap();
        let b = new_wallet(Network::MainNetwork, 1).unwrap();
        assert_ne!(a.mnemonic, b.mnemonic);
        assert_ne!(a.address, b.address);
        assert_eq!(a.mnemonic.split_whitespace().count(), 24);
    }

    // --- spending keys ---------------------------------------------------------

    #[test]
    fn spending_keys_match_the_viewing_key_the_scan_uses() {
        let secret = vector_secret();
        let keys = spend_keys_from_secret(&secret, Network::MainNetwork).unwrap();
        let ufvk = crate::ufvk_from_secret(&secret, Network::MainNetwork).unwrap();
        assert_eq!(
            keys.fvk.to_ivk(Scope::External).to_bytes(),
            ufvk.orchard().unwrap().to_ivk(Scope::External).to_bytes(),
            "the key that finds the note must be the key that spends it"
        );
    }

    #[test]
    fn a_bad_secret_yields_no_spending_keys() {
        assert!(spend_keys_from_secret("nope", Network::MainNetwork).is_err());
    }

    // --- witness replay --------------------------------------------------------

    #[test]
    fn a_witness_is_only_taken_at_the_target_action() {
        use zcash_client_backend::proto::compact_formats::{CompactOrchardAction, CompactTx};

        // Real-looking commitments: the empty-root node bytes are a valid field element.
        let leaf = MerkleHashOrchard::empty_leaf().to_bytes().to_vec();
        let action = |cmx: Vec<u8>| CompactOrchardAction {
            nullifier: vec![0u8; 32],
            cmx,
            ephemeral_key: vec![1u8; 32],
            ciphertext: vec![7u8; 52],
        };
        let block = CompactBlock {
            height: 3_490_472,
            vtx: vec![
                CompactTx {
                    index: 0,
                    txid: vec![1u8; 32],
                    ironwood_actions: vec![action(leaf.clone())],
                    ..Default::default()
                },
                CompactTx {
                    index: 1,
                    txid: vec![2u8; 32],
                    ironwood_actions: vec![action(leaf.clone()), action(leaf.clone())],
                    ..Default::default()
                },
            ],
            ..Default::default()
        };

        let mut scan = WitnessScan::new(IronwoodTree::empty());
        scan.append_block(&block, Some((&[2u8; 32], 1))).unwrap();
        assert_eq!(scan.appended(), 3);
        // Tx 0 contributes leaf 0; tx 1 contributes leaves 1 and 2; ours is the last.
        assert_eq!(scan.position(), Some(2));

        // An action index that is not in the block leaves no witness.
        let mut scan = WitnessScan::new(IronwoodTree::empty());
        scan.append_block(&block, Some((&[2u8; 32], 9))).unwrap();
        assert_eq!(scan.position(), None);
        assert!(scan.finish("whatever").is_err());
    }

    #[test]
    fn a_root_mismatch_is_a_hard_error() {
        use zcash_client_backend::proto::compact_formats::{CompactOrchardAction, CompactTx};

        let leaf = MerkleHashOrchard::empty_leaf().to_bytes().to_vec();
        let block = CompactBlock {
            height: 1,
            vtx: vec![CompactTx {
                index: 0,
                txid: vec![3u8; 32],
                ironwood_actions: vec![CompactOrchardAction {
                    nullifier: vec![0u8; 32],
                    cmx: leaf,
                    ephemeral_key: vec![1u8; 32],
                    ciphertext: vec![7u8; 52],
                }],
                ..Default::default()
            }],
            ..Default::default()
        };

        let mut scan = WitnessScan::new(IronwoodTree::empty());
        scan.append_block(&block, Some((&[3u8; 32], 0))).unwrap();
        let real_root = scan.tree_root_hex();
        assert_eq!(scan.witness_root_hex().as_deref(), Some(real_root.as_str()));

        let err = scan.finish(&"00".repeat(32)).unwrap_err();
        assert!(err.contains("does not match the server"), "{err}");
    }

    /// Prints the M3 vectors so TEST_VECTORS.md can be regenerated:
    /// `cargo test -p zenvelope-core -- --ignored --nocapture print_m3_test_vectors`
    #[test]
    #[ignore]
    fn print_m3_test_vectors() {
        println!("mnemonic\t{VECTOR_MNEMONIC}");
        println!(
            "sapling.example\t{}",
            ZcashAddress::from_sapling(NetworkType::Main, [0u8; 43])
        );
        let mnemonic = Mnemonic::<English>::from_phrase(VECTOR_MNEMONIC.to_string()).unwrap();
        println!("seed\t{}", hex::encode(mnemonic.to_seed("")));
        for (label, network) in [
            ("main", Network::MainNetwork),
            ("test", Network::TestNetwork),
        ] {
            let w = wallet_from_mnemonic(VECTOR_MNEMONIC, network, 0).unwrap();
            println!("{label}.wallet.address\t{}", w.address);
            println!("{label}.wallet.ufvk\t{}", w.ufvk);
            let verdict = classify_address(&w.address, network);
            println!("{label}.wallet.kind\t{}", verdict.kind.as_str());
            let (_, receivers) = crate::decode_receivers(&w.address).unwrap();
            let names: Vec<&str> = receivers
                .iter()
                .map(|r| match r {
                    Receiver::Orchard(_) => "orchard",
                    Receiver::Sapling(_) => "sapling",
                    Receiver::P2pkh(_) => "p2pkh",
                    Receiver::P2sh(_) => "p2sh",
                    Receiver::Unknown { .. } => "unknown",
                })
                .collect();
            println!("{label}.wallet.receivers\t{}", names.join(", "));
        }
        for (label, outputs) in [
            ("2 shielded", vec![shielded(), shielded()]),
            ("1 shielded", vec![shielded()]),
            (
                "1 shielded + 1 transparent",
                vec![shielded(), transparent_p2pkh()],
            ),
        ] {
            println!("fee[{label}]\t{}", network_fee_zat(&outputs));
        }
    }

    #[test]
    fn a_malformed_commitment_is_refused() {
        assert!(cmx_node(&[0u8; 31]).is_err());
        assert!(cmx_node(&[0xffu8; 32]).is_err(), "not a field element");
        assert!(cmx_node(&MerkleHashOrchard::empty_leaf().to_bytes()).is_ok());
    }
}
