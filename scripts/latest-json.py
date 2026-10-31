#!/usr/bin/env python3
"""Writes latest.json, which installed apps check for updates
(design/ARCHITECTURE.md §7.3), from a release's update packages and their
signatures. Run once after every desktop build has added its files, so the
builds never edit the same file at the same time.

    latest-json.py <tag> <repo owner/name> <dir with the .sig files> <notes file> > latest.json

Fails when a platform's package or signature is missing: a release that
cannot update every platform is not offered to any.
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# Package (by name ending) -> the platform keys the updater looks up. The
# first key of each platform is its default: NSIS on Windows, AppImage on
# Linux (tauri-action's updaterJsonPreferNsis).
PLATFORMS = [
    (".app.tar.gz", ["darwin-aarch64", "darwin-x86_64", "darwin-aarch64-app", "darwin-x86_64-app"]),
    ("-setup.exe", ["windows-x86_64", "windows-x86_64-nsis"]),
    (".msi", ["windows-x86_64-msi"]),
    (".AppImage", ["linux-x86_64", "linux-x86_64-appimage"]),
    (".deb", ["linux-x86_64-deb"]),
    (".rpm", ["linux-x86_64-rpm"]),
]


def main() -> None:
    tag, repo, sig_dir, notes_file = sys.argv[1:5]
    sigs = sorted(Path(sig_dir).glob("*.sig"))
    platforms = {}
    missing = []
    for ending, keys in PLATFORMS:
        found = [s for s in sigs if s.name[: -len(".sig")].endswith(ending)]
        if len(found) != 1:
            missing.append(f"{ending} ({len(found)} found)")
            continue
        package = found[0].name[: -len(".sig")]
        entry = {
            "signature": found[0].read_text().strip(),
            "url": f"https://github.com/{repo}/releases/download/{tag}/{package}",
        }
        for key in keys:
            platforms[key] = entry
    if missing:
        sys.exit("latest.json: no single package for " + ", ".join(missing))
    json.dump(
        {
            "version": tag.removeprefix("v"),
            "notes": Path(notes_file).read_text().strip(),
            "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            "platforms": platforms,
        },
        sys.stdout,
        indent=2,
        ensure_ascii=False,
    )
    print()


if __name__ == "__main__":
    main()
