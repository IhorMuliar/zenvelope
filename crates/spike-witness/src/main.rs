//! M3 spike: prove the witness recipe for a real Ironwood note.
//!
//! Throwaway. Talks native gRPC (tonic) to a mainnet lightwalletd, rebuilds the
//! Ironwood note commitment tree across a span of blocks, and checks every root it
//! computes against the server's own `GetTreeState`. Nothing here is a secret and
//! nothing here is written to disk.

use std::time::Instant;

use anyhow::{anyhow, bail, Context, Result};
use incrementalmerkletree::{frontier::CommitmentTree, witness::IncrementalWitness};
use orchard::{note::ExtractedNoteCommitment, tree::MerkleHashOrchard, Anchor};
use prost::Message;
use tonic::transport::{Channel, ClientTlsConfig};
use zcash_client_backend::proto::service::{
    compact_tx_streamer_client::CompactTxStreamerClient, BlockId, BlockRange,
};

/// Ironwood shares Orchard's tree shape: depth 32.
const DEPTH: u8 = orchard::NOTE_COMMITMENT_TREE_DEPTH as u8;

type Tree = CommitmentTree<MerkleHashOrchard, DEPTH>;
type Witness = IncrementalWitness<MerkleHashOrchard, DEPTH>;

const SERVER: &str = "https://zec.rocks:443";
/// Display (byte-reversed) txid of the transaction holding the note.
const TXID_DISPLAY: &str = "281e9f7bffa5bffc8ee1287cc6e245cc59eee302727ea9d93c7f8e5a99341d43";
const NOTE_HEIGHT: u64 = 3_490_472;
/// How many blocks past the note's block to keep the witness rolling forward.
const N: u64 = 20;

/// Bytes of protobuf payload pulled from the server, counted as we go.
#[derive(Default)]
struct Meter {
    bytes: u64,
}

impl Meter {
    fn add<M: Message>(&mut self, m: &M) {
        self.bytes += m.encoded_len() as u64;
    }
}

fn node(cmx: &[u8]) -> Result<MerkleHashOrchard> {
    let bytes: [u8; 32] = cmx
        .try_into()
        .map_err(|_| anyhow!("cmx is {} bytes, want 32", cmx.len()))?;
    let cmx = Option::<ExtractedNoteCommitment>::from(ExtractedNoteCommitment::from_bytes(&bytes))
        .ok_or_else(|| anyhow!("cmx is not a valid Pallas base field element"))?;
    Ok(MerkleHashOrchard::from_cmx(&cmx))
}

fn hexs(h: &MerkleHashOrchard) -> String {
    hex::encode(h.to_bytes())
}

async fn tree_state(
    client: &mut CompactTxStreamerClient<Channel>,
    meter: &mut Meter,
    height: u64,
) -> Result<Tree> {
    let state = client
        .get_tree_state(BlockId {
            height,
            hash: vec![],
        })
        .await
        .with_context(|| format!("GetTreeState({height})"))?
        .into_inner();
    meter.add(&state);
    state
        .ironwood_tree()
        .with_context(|| format!("parsing ironwood_tree at {height}"))
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    let started = Instant::now();
    let mut meter = Meter::default();

    // Our txid in protocol (internal) byte order.
    let mut txid = hex::decode(TXID_DISPLAY)?;
    txid.reverse();

    let channel = Channel::from_static(SERVER)
        .tls_config(ClientTlsConfig::new().with_webpki_roots())?
        .connect()
        .await
        .context("connecting to lightwalletd")?;
    let mut client =
        CompactTxStreamerClient::new(channel).max_decoding_message_size(64 * 1024 * 1024);

    // 1. The frontier as of the block before the note.
    let mut tree = tree_state(&mut client, &mut meter, NOTE_HEIGHT - 1).await?;
    let start_size = tree.size();
    println!(
        "[1] ironwood tree at {}: {start_size} leaves",
        NOTE_HEIGHT - 1
    );
    println!("    root {}", hexs(&tree.root()));

    // 2. Replay the note's block, appending every ironwood cmx in order.
    let block = client
        .get_block(BlockId {
            height: NOTE_HEIGHT,
            hash: vec![],
        })
        .await
        .context("GetBlock")?
        .into_inner();
    meter.add(&block);

    let mut witnesses: Vec<(usize, Witness)> = Vec::new();
    let mut in_block = 0usize;
    for tx in &block.vtx {
        let ours = tx.txid == txid;
        for (i, action) in tx.ironwood_actions.iter().enumerate() {
            tree.append(node(&action.cmx)?)
                .map_err(|_| anyhow!("ironwood tree full"))?;
            in_block += 1;
            // Every witness already taken must see this leaf too, except the one
            // that was just created from it.
            for (_, w) in witnesses.iter_mut() {
                w.append(node(&action.cmx)?)
                    .map_err(|_| anyhow!("witness full"))?;
            }
            if ours {
                let w = Witness::from_tree(tree.clone()).ok_or_else(|| anyhow!("empty tree"))?;
                println!(
                    "[2] our ironwood action #{i} in tx {TXID_DISPLAY} (tx index {}) at position {}",
                    tx.index,
                    u64::from(w.witnessed_position())
                );
                witnesses.push((i, w));
            }
        }
    }
    if witnesses.is_empty() {
        bail!("txid {TXID_DISPLAY} has no ironwood actions in block {NOTE_HEIGHT}");
    }
    println!(
        "[2] block {NOTE_HEIGHT}: {} txs, {in_block} ironwood commitments, {} of them ours",
        block.vtx.len(),
        witnesses.len()
    );

    // 3. Ordering guard: our replay must reproduce the server's own root.
    let want = tree_state(&mut client, &mut meter, NOTE_HEIGHT)
        .await?
        .root();
    let got = tree.root();
    assert_eq!(
        hexs(&got),
        hexs(&want),
        "replayed root at {NOTE_HEIGHT} does not match GetTreeState"
    );
    println!(
        "[3] OK root at {NOTE_HEIGHT} matches GetTreeState: {}",
        hexs(&got)
    );

    // 5. The O(1) variant: anchor at the note's own block, zero further appends.
    for (i, w) in &witnesses {
        let anchor = Anchor::from(w.root());
        assert_eq!(
            hex::encode(anchor.to_bytes()),
            hexs(&want),
            "same-block witness root does not match GetTreeState({NOTE_HEIGHT})"
        );
        println!(
            "[5] OK same-block anchor for action #{i}: {}",
            hex::encode(anchor.to_bytes())
        );
    }

    // 4. Roll forward N more blocks into both the tree and every witness.
    let end = NOTE_HEIGHT + N;
    let mut stream = client
        .get_block_range(BlockRange {
            start: Some(BlockId {
                height: NOTE_HEIGHT + 1,
                hash: vec![],
            }),
            end: Some(BlockId {
                height: end,
                hash: vec![],
            }),
            ..Default::default()
        })
        .await
        .context("GetBlockRange")?
        .into_inner();

    let mut per_block: Vec<(u64, usize)> = vec![(NOTE_HEIGHT, in_block)];
    while let Some(b) = stream.message().await? {
        meter.add(&b);
        let mut n = 0usize;
        for tx in &b.vtx {
            for action in &tx.ironwood_actions {
                let leaf = node(&action.cmx)?;
                tree.append(leaf).map_err(|_| anyhow!("tree full"))?;
                for (_, w) in witnesses.iter_mut() {
                    w.append(leaf).map_err(|_| anyhow!("witness full"))?;
                }
                n += 1;
            }
        }
        per_block.push((b.height, n));
    }

    let want_end = tree_state(&mut client, &mut meter, end).await?.root();
    assert_eq!(
        hexs(&tree.root()),
        hexs(&want_end),
        "replayed root at {end} does not match GetTreeState"
    );
    println!(
        "[4] OK root at {end} matches GetTreeState: {}",
        hexs(&want_end)
    );

    for (i, w) in &witnesses {
        assert_eq!(
            hexs(&w.root()),
            hexs(&want_end),
            "witness root at {end} does not match the tree root"
        );
        let path = orchard::tree::MerklePath::from(w.path().ok_or_else(|| anyhow!("no path"))?);
        let anchor = Anchor::from(w.root());
        println!("[4] OK witness for action #{i}");
        println!("    position   {}", u64::from(w.witnessed_position()));
        println!("    anchor@{end} {}", hex::encode(anchor.to_bytes()));
        // A MerklePath recomputes the anchor from the leaf; check it closes the loop.
        let leaf_cmx = {
            let tx = block
                .vtx
                .iter()
                .find(|tx| tx.txid == txid)
                .expect("our tx was found above");
            let bytes: [u8; 32] = tx.ironwood_actions[*i].cmx[..].try_into()?;
            Option::<ExtractedNoteCommitment>::from(ExtractedNoteCommitment::from_bytes(&bytes))
                .ok_or_else(|| anyhow!("bad cmx"))?
        };
        let recomputed = path.root(leaf_cmx);
        assert_eq!(
            hex::encode(recomputed.to_bytes()),
            hex::encode(anchor.to_bytes()),
            "MerklePath does not recompute the anchor"
        );
        println!("    MerklePath::root(cmx) reproduces the anchor: OK");
    }

    // 6. Cost.
    let elapsed = started.elapsed();
    let total: usize = per_block.iter().map(|(_, n)| n).sum();
    let blocks = per_block.len();
    println!("[6] ironwood commitments per block over {blocks} blocks:");
    for (h, n) in &per_block {
        println!("    {h} {n}");
    }
    println!(
        "[6] total {total} commitments, mean {:.2}/block",
        total as f64 / blocks as f64
    );
    println!(
        "[6] protobuf payload downloaded: {} bytes ({:.1} KiB)",
        meter.bytes,
        meter.bytes as f64 / 1024.0
    );
    println!("[6] wall time: {:.2} s", elapsed.as_secs_f64());
    println!("ALL ASSERTIONS PASSED");
    Ok(())
}
