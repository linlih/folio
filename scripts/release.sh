#!/usr/bin/env bash
# Publishes a version: sets it everywhere, commits, tags with the release
# notes, and with --push sends both to GitHub, where the "Build apps"
# workflow builds and publishes the release that installed apps update from.
#
#   ./scripts/release.sh 0.2.0 -m "新增：思维导图" [--push]
#   ./scripts/release.sh 0.2.0 -F notes.md --push
set -euo pipefail
cd "$(dirname "$0")/.."

usage() { echo "usage: $0 <version> (-m <notes> | -F <file>) [--push]" >&2; exit 2; }
[[ $# -ge 1 ]] || usage
version="${1#v}"; shift
notes=""; push=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m) notes="$2"; shift 2 ;;
    -F) notes="$(cat "$2")"; shift 2 ;;
    --push) push=1; shift ;;
    *) usage ;;
  esac
done
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "not a version: $version" >&2; exit 2; }
[[ -n "$notes" ]] || { echo "release notes are needed (-m or -F): they are what the update prompt shows" >&2; exit 2; }
[[ -z "$(git status --porcelain)" ]] || { echo "commit or stash your changes first" >&2; exit 1; }
[[ "$(git branch --show-current)" == "main" ]] || { echo "release from main" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/v$version" >/dev/null && { echo "v$version exists already" >&2; exit 1; }

# The app's version (tauri.conf.json) is what updates compare against.
node - "$version" <<'EOF'
const fs = require("fs");
const v = process.argv[2];
const sub = (file, re, to) => {
  const s = fs.readFileSync(file, "utf8");
  if (!re.test(s)) throw new Error(`no version in ${file}`);
  fs.writeFileSync(file, s.replace(re, to));
};
sub("src-tauri/tauri.conf.json", /("version":\s*")[^"]+(")/, `$1${v}$2`);
sub("web/package.json", /("version":\s*")[^"]+(")/, `$1${v}$2`);
sub("Cargo.toml", /(\[workspace\.package\][^\[]*?\nversion = ")[^"]+(")/, `$1${v}$2`);
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
if (lock.packages?.web) lock.packages.web.version = v;
fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
EOF
cargo update --workspace --quiet

git commit --quiet -am "Release v$version"
git tag -a "v$version" -m "$notes"
echo "tagged v$version"
if [[ $push -eq 1 ]]; then
  git push --quiet origin main "v$version"
  echo "pushed; the release appears at https://github.com/linlih/folio/releases once the builds finish"
else
  echo "to publish: git push origin main v$version"
fi
