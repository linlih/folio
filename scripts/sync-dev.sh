#!/usr/bin/env bash
# Try sync on one computer (design/ARCHITECTURE.md §5.3):
#
#   scripts/sync-dev.sh server       # the relay on http://127.0.0.1:8787; prints its token
#   scripts/sync-dev.sh copy a       # a desktop copy with its own library in .sync-dev/a
#   scripts/sync-dev.sh copy b       # another one
#   scripts/sync-dev.sh reset        # forget the test server and copies
#
# Copies load the frontend from Vite on port 5173, so keep `npm run tauri dev`
# (or `npm --prefix web run dev`) running. Each copy runs its own snapshot of
# the app binary, so a rebuild by `tauri dev` does not touch it. Their
# libraries are separate from the main app's.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=.sync-dev
mkdir -p "$DIR"

token() {
  [ -f "$DIR/token" ] || openssl rand -hex 24 > "$DIR/token"
  cat "$DIR/token"
}

case "${1:-}" in
  server)
    cargo build -q -p folio-server
    echo "Server token (paste into Settings → Sync → New sync space):"
    echo "  $(token)"
    echo
    FOLIO_SERVER_TOKEN="$(token)" FOLIO_SERVER_DB="$DIR/server.db" FOLIO_SERVER_ADDR="${FOLIO_SERVER_ADDR:-127.0.0.1:8787}" \
      exec target/debug/folio-server
    ;;
  copy)
    name="${2:?usage: sync-dev.sh copy NAME}"
    if ! curl -s -o /dev/null http://localhost:5173; then
      echo "Vite is not running on port 5173: start npm run tauri dev (or npm --prefix web run dev) first." >&2
      exit 1
    fi
    cargo build -q -p folio
    cp target/debug/folio "$DIR/folio-$name"
    echo "Starting copy \"$name\" with its library in $DIR/$name"
    FOLIO_DATA_DIR="$PWD/$DIR/$name" exec "$DIR/folio-$name"
    ;;
  reset)
    rm -rf "$DIR"
    echo "Removed $DIR (test server data, token and copies' libraries)."
    ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
