//! Criterion 2 for the board document: three replicas edit concurrently with
//! random disconnects, then every pair syncs; all must converge.

mod common;

use common::Rng;
use crdt_spike::{DocEngine, loro_engine::LoroEngine, yrs_engine::YrsEngine};

const RUNS: u64 = 100;
const STEPS: usize = 1000;

fn sync_pair<E: DocEngine>(a: &E, b: &E) {
    let to_b = a.export_since(&b.version()).unwrap();
    let to_a = b.export_since(&a.version()).unwrap();
    b.apply_update(&to_b).unwrap();
    a.apply_update(&to_a).unwrap();
}

fn run<E: DocEngine>() -> (usize, usize) {
    let mut steps = 0;
    let mut divergent_runs = 0;
    for seed in 0..RUNS {
        let mut rng = Rng::new(seed + 1);
        let peers: Vec<E> = (0..3).map(|i| E::new(seed * 10 + i + 1)).collect();
        let mut online = [true; 3];
        let mut next_id = 0usize;
        for _ in 0..STEPS {
            steps += 1;
            if rng.chance(0.05) {
                let i = rng.below(3);
                online[i] = !online[i];
            }
            let p = rng.below(3);
            let e = &peers[p];
            let item = format!("i{}", rng.below(next_id.max(1)));
            match rng.below(10) {
                0..=2 => {
                    next_id += 1;
                    e.board_put_item(&format!("i{next_id}"), &format!("card{}", rng.below(50)), 0.0, 0.0, 240.0, 160.0);
                }
                3..=6 => e.board_move_item(&item, rng.below(5000) as f64, rng.below(5000) as f64),
                7 => e.board_remove_item(&item),
                8 => e.board_put_edge(&format!("e{}", rng.below(100)), &item, &format!("i{}", rng.below(next_id.max(1)))),
                _ => e.board_remove_edge(&format!("e{}", rng.below(100))),
            }
            // Online peers sync with each other right away, in random pair order.
            for _ in 0..2 {
                let (a, b) = (rng.below(3), rng.below(3));
                if a != b && online[a] && online[b] {
                    sync_pair(&peers[a], &peers[b]);
                }
            }
        }
        for a in 0..3 {
            for b in (a + 1)..3 {
                sync_pair(&peers[a], &peers[b]);
            }
        }
        let states: Vec<_> = peers.iter().map(|p| p.board_canonical()).collect();
        if states[0] != states[1] || states[1] != states[2] {
            divergent_runs += 1;
            eprintln!("{} seed {seed} diverged", E::NAME);
        }
    }
    (steps, divergent_runs)
}

#[test]
fn board_converges_loro() {
    let (steps, bad) = run::<LoroEngine>();
    println!("loro board: {steps} steps, {bad} divergent runs");
    assert_eq!(bad, 0);
}

#[test]
fn board_converges_yrs() {
    let (steps, bad) = run::<YrsEngine>();
    println!("yjs board: {steps} steps, {bad} divergent runs");
    assert_eq!(bad, 0);
}
