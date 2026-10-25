//! Criterion 4, Rust side: how long the core takes to load a card that was
//! edited for a year (blobs written by `BENCH=growth vitest`) and extract its
//! content, which is what the indexer does after every change.

use std::time::Instant;

use crdt_spike::{DocEngine, loro_engine::LoroEngine, yrs_engine::YrsEngine};

fn blobs_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../results/blobs")
}

fn measure<E: DocEngine>() {
    for kind in ["snapshot", "compact"] {
        let path = blobs_dir().join(format!("growth-{}.{kind}", E::NAME));
        let Ok(bytes) = std::fs::read(&path) else {
            println!("{}: {} missing, run the growth bench first", E::NAME, path.display());
            return;
        };
        let mut load = Vec::new();
        let mut extract = Vec::new();
        for _ in 0..20 {
            let t = Instant::now();
            let e = E::load(&bytes, 1).unwrap();
            load.push(t.elapsed().as_secs_f64() * 1000.0);
            let t = Instant::now();
            let v = e.card_canonical();
            extract.push(t.elapsed().as_secs_f64() * 1000.0);
            assert!(!v.is_null());
        }
        load.sort_by(f64::total_cmp);
        extract.sort_by(f64::total_cmp);
        println!(
            "{} {kind}: {} B, load p50 {:.2} ms, extract p50 {:.2} ms",
            E::NAME,
            bytes.len(),
            load[load.len() / 2],
            extract[extract.len() / 2]
        );
    }
}

#[test]
fn growth_load() {
    measure::<LoroEngine>();
    measure::<YrsEngine>();
}

/// Loro's smallest export (Rust only): current state plus a minimal history.
#[test]
fn loro_state_only_size() {
    use loro::ExportMode;
    let Ok(bytes) = std::fs::read(blobs_dir().join("growth-loro.snapshot")) else {
        return;
    };
    let e = LoroEngine::load(&bytes, 1).unwrap();
    let state_only = e.doc.export(ExportMode::StateOnly(None)).unwrap();
    let back = LoroEngine::load(&state_only, 2).unwrap();
    assert_eq!(back.card_canonical(), e.card_canonical());
    println!("loro state-only: {} B (snapshot {} B)", state_only.len(), bytes.len());
}
