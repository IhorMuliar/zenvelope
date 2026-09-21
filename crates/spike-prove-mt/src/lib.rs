//! THROWAWAY M4 spike: the threaded twin of `crates/spike-prove`.
//!
//! Question: how much of the ~35 s proving-key build and ~52 s proof does a wasm thread
//! pool buy back, and what does the build need?
//!
//! Everything below the `init_threads` export is a byte-for-byte copy of
//! `crates/spike-prove/src/lib.rs`, so the only variables are `orchard/multicore` (which
//! turns on rayon inside halo2) and the pool this module starts.
//!
//! Nothing here is production code. It exists to answer that question and then die.

use std::cell::RefCell;

use incrementalmerkletree::{Hashable, Level};
use orchard::{
    builder::{Builder, BundleType},
    bundle::{BundleVersion, Flags, TxVersion},
    circuit::{OrchardCircuitVersion, ProvingKey, VerifyingKey},
    keys::{FullViewingKey, Scope, SpendAuthorizingKey, SpendingKey},
    note::ExtractedNoteCommitment,
    tree::{Anchor, MerkleHashOrchard, MerklePath},
    value::NoteValue,
};
use rand::SeedableRng;
use rand_chacha::ChaCha20Rng;
use wasm_bindgen::prelude::*;

/// wasm-bindgen-rayon's `initThreadPool(n) -> Promise`. Re-exporting it is what puts it
/// in the generated JS; it must be awaited on the main thread, after `init()` and before
/// anything that touches rayon.
pub use wasm_bindgen_rayon::init_thread_pool;

/// Alias with the name the task asked for. `initThreadPool` is the one the JS glue
/// actually exports; this is a thin wrapper so either name works.
#[wasm_bindgen]
pub fn init_threads(num_threads: usize) -> js_sys::Promise {
    wasm_bindgen_rayon::init_thread_pool(num_threads)
}

/// How many threads rayon's global pool currently has. 1 means `initThreadPool` was
/// never awaited (or failed) and every `par_iter` below is running serially.
#[wasm_bindgen]
pub fn thread_count() -> usize {
    rayon::current_num_threads()
}

/// The circuit version every Ironwood (post-NU6.3) bundle proves against.
const CIRCUIT: OrchardCircuitVersion = OrchardCircuitVersion::PostNu6_3;

thread_local! {
    static PK: RefCell<Option<ProvingKey>> = const { RefCell::new(None) };
    static VK: RefCell<Option<VerifyingKey>> = const { RefCell::new(None) };
}

fn now_ms() -> f64 {
    js_sys::Date::now()
}

/// Current wasm linear memory, in bytes.
fn mem() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        (core::arch::wasm32::memory_size(0) as f64) * 65536.0
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0.0
    }
}

/// Builds the post-NU6.3 proving key and stashes it. Returns elapsed milliseconds.
#[wasm_bindgen]
pub fn build_pk() -> f64 {
    let t0 = now_ms();
    let pk = ProvingKey::build(CIRCUIT);
    let elapsed = now_ms() - t0;
    PK.with(|slot| *slot.borrow_mut() = Some(pk));
    elapsed
}

/// Builds the post-NU6.3 verifying key and stashes it. Returns elapsed milliseconds.
#[wasm_bindgen]
pub fn build_vk() -> f64 {
    let t0 = now_ms();
    let vk = VerifyingKey::build(CIRCUIT);
    let elapsed = now_ms() - t0;
    VK.with(|slot| *slot.borrow_mut() = Some(vk));
    elapsed
}

/// The auth path of the single leaf at position 0 of an otherwise empty tree: every
/// sibling is the empty root of its level. Saves pulling in `shardtree` just to witness
/// one note.
fn single_leaf_auth_path() -> [MerkleHashOrchard; 32] {
    core::array::from_fn(|i| MerkleHashOrchard::empty_root(Level::from(i as u8)))
}

/// Builds a 2-action Ironwood bundle (one REAL spend of a note witnessed in an ad-hoc
/// single-leaf tree, one output to a fresh internal address), proves it, signs it and
/// verifies the proof.
///
/// Returns a JSON string: build ms, proof ms, verify ms, action count, proof bytes and
/// the wasm memory high-water mark seen at each step.
#[wasm_bindgen]
pub fn prove_dummy() -> String {
    let mut rng = ChaCha20Rng::from_seed([7u8; 32]);

    let sk = SpendingKey::from_bytes([0u8; 32]).unwrap();
    let fvk = FullViewingKey::from(&sk);
    let recipient = fvk.address_at(0u32, Scope::External);
    let change_addr = fvk.address_at(0u32, Scope::Internal);

    let version = BundleVersion::ironwood_v3();

    let t_build = now_ms();

    // 1. Shield a note to spend: an output-only Ironwood bundle, never proved. We only
    //    need the note it creates, and its commitment.
    let mut shielding = Builder::new(
        BundleType::DEFAULT,
        version,
        Flags::SPENDS_DISABLED,
        Anchor::empty_tree(),
    )
    .expect("shielding flags are valid for Ironwood");
    shielding
        .add_output(None, recipient, NoteValue::from_raw(5000), [0u8; 512])
        .expect("output is addable");
    let (shielding_bundle, meta) = shielding
        .build::<i64>(&mut rng)
        .expect("shielding bundle builds")
        .expect("shielding bundle is non-empty");
    let idx = meta.output_action_index(0).expect("output 0 is present");
    let (note, _, _) = shielding_bundle
        .decrypt_output_with_key(idx, &fvk.to_ivk(Scope::External))
        .expect("the V3 output decrypts");

    // 2. Witness it in an ad-hoc one-leaf tree, so the spend is a real spend.
    let cmx: ExtractedNoteCommitment = note.commitment().into();
    let merkle_path = MerklePath::from_parts(0, single_leaf_auth_path());
    let anchor = merkle_path.root(cmx);

    // 3. The bundle under test: 1 spend + 1 output = 2 actions.
    let mut builder = Builder::new(
        BundleType::DEFAULT,
        version,
        version.default_flags(),
        anchor,
    )
    .expect("default Ironwood flags are valid");
    builder
        .add_spend(fvk.clone(), note, merkle_path)
        .expect("the witness roots to the anchor");
    builder
        .add_output(None, change_addr, NoteValue::from_raw(5000), [0u8; 512])
        .expect("output is addable");
    let (unauthorized, _) = builder
        .build::<i64>(&mut rng)
        .expect("bundle builds")
        .expect("bundle is non-empty");
    let build_ms = now_ms() - t_build;
    let mem_after_build = mem();

    let n_actions = unauthorized.actions().len();
    assert_eq!(unauthorized.circuit_version(), CIRCUIT);

    let sighash: [u8; 32] = unauthorized
        .commitment(TxVersion::V6)
        .expect("Ironwood flags are representable in V6")
        .into();

    // 4. Prove.
    let t_proof = now_ms();
    let proven = PK.with(|slot| {
        let borrowed = slot.borrow();
        let pk = borrowed.as_ref().expect("build_pk() was called first");
        unauthorized.create_proof(pk, &mut rng).expect("proof")
    });
    let proof_ms = now_ms() - t_proof;
    let mem_after_proof = mem();

    let bundle = proven
        .apply_signatures(rng, sighash, &[SpendAuthorizingKey::from(&sk)])
        .expect("signatures apply");
    let proof_bytes = bundle.authorization().proof().as_ref().len();

    // 5. Verify.
    let t_verify = now_ms();
    let verified = VK.with(|slot| {
        let borrowed = slot.borrow();
        let vk = borrowed.as_ref().expect("build_vk() was called first");
        bundle.verify_proof(vk).is_ok()
    });
    let verify_ms = now_ms() - t_verify;
    let mem_after_verify = mem();

    format!(
        concat!(
            r#"{{"build_ms":{},"proof_ms":{},"verify_ms":{},"verified":{},"#,
            r#""actions":{},"proof_bytes":{},"#,
            r#""mem_after_build":{},"mem_after_proof":{},"mem_after_verify":{}}}"#
        ),
        build_ms,
        proof_ms,
        verify_ms,
        verified,
        n_actions,
        proof_bytes,
        mem_after_build,
        mem_after_proof,
        mem_after_verify,
    )
}

/// Current wasm linear memory size in bytes.
#[wasm_bindgen]
pub fn mem_bytes() -> f64 {
    mem()
}
