#!/usr/bin/env bash
# Frees disk space taken by build output that no recent build used:
# dependencies' old versions, platforms and profiles not built lately.
# What recent builds use stays, so they stay fast.
#
#   scripts/clean-target.sh [days]   # default 30
#
# Needs cargo-sweep: cargo install cargo-sweep
set -euo pipefail
cd "$(dirname "$0")/.."
days="${1:-30}"
if ! cargo sweep --version >/dev/null 2>&1; then
  echo "cargo-sweep is not installed: cargo install cargo-sweep" >&2
  exit 1
fi
before=$(du -sh target 2>/dev/null | cut -f1 || echo 0)
cargo sweep --time "$days" .
# The mobile projects' build folders are rebuilt in full each time.
for d in src-tauri/gen/apple/build src-tauri/gen/android/app/build src-tauri/gen/android/build; do
  if [ -d "$d" ] && [ -z "$(find "$d" -mtime "-${days}" -print -quit)" ]; then rm -rf "$d"; fi
done
echo "target: $before → $(du -sh target 2>/dev/null | cut -f1 || echo 0)"
