#!/usr/bin/env bash
# Every test in the repo: Rust workspace, then frontend types and unit tests.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== cargo test"
cargo test --workspace --quiet

echo "== web typecheck"
npm --prefix web run --silent typecheck

echo "== web tests"
npm --prefix web run --silent test
