#!/usr/bin/env bash
# Downloads the bundled body fonts (design/ARCHITECTURE.md §0.2) into
# web/public/fonts from a pinned google/fonts commit and checks their SHA-256.
# Both families are under the SIL Open Font License; the licence texts are
# fetched alongside and must ship with the app.
set -euo pipefail

COMMIT=e7db6ca603fd4862010383ff17ffd6cc4ffac1c0
BASE="https://raw.githubusercontent.com/google/fonts/$COMMIT/ofl"
DEST="$(cd "$(dirname "$0")/.." && pwd)/web/public/fonts"
mkdir -p "$DEST"

# local name | path in google/fonts | sha256
FILES="
NotoSerifSC-Variable.ttf|notoserifsc/NotoSerifSC%5Bwght%5D.ttf|050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9
NotoSerifSC-OFL.txt|notoserifsc/OFL.txt|5e0da210fb04058a8c0087985d2d456b931c2579811a49655721d3cf0c36b6d6
SourceSerif4-Variable.ttf|sourceserif4/SourceSerif4%5Bopsz,wght%5D.ttf|97b2d4da6e3cb494b5a1e66ae176914d852ccabef49e0c02c0df25f3e39aca0b
SourceSerif4-Italic-Variable.ttf|sourceserif4/SourceSerif4-Italic%5Bopsz,wght%5D.ttf|15fbc7e4679489a501998c3669272637a6646388ef7e4bd77eebb5bf967a1f42
SourceSerif4-OFL.txt|sourceserif4/OFL.txt|5f94c3fd3a23131a417ab5a0c8452de57e70c3cfb9f604d88241f7065ebf9fd9
"

# sha256sum on Linux and Git Bash for Windows, shasum on macOS.
sha() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

for line in $FILES; do
  IFS='|' read -r name path want <<<"$line"
  out="$DEST/$name"
  if [[ -f "$out" && "$(sha "$out")" == "$want" ]]; then
    echo "ok       $name"
    continue
  fi
  echo "fetching $name"
  curl -fsSL "$BASE/$path" -o "$out.part"
  got="$(sha "$out.part")"
  if [[ "$got" != "$want" ]]; then
    rm -f "$out.part"
    echo "checksum mismatch for $name: got $got" >&2
    exit 1
  fi
  mv "$out.part" "$out"
done
