#!/usr/bin/env bash
# Adds "Folio" to the iOS share sheet (design/inbox-and-tags.md §2): a share
# extension target built from src-tauri/ios-share, and the App Group it and
# the app share, in the generated Xcode project. src-tauri/gen/apple is made
# by `npx tauri ios init` and not kept in the repository, so run this after
# each init:
#
#   npx tauri ios init && scripts/ios-share.sh
#
# Running it again changes nothing. On an iPhone, signing needs an Apple
# developer team whose profiles include the App Group; the simulator needs
# none.
set -euo pipefail
cd "$(dirname "$0")/.."
SPEC=src-tauri/gen/apple/project.yml
[ -f "$SPEC" ] || { echo "No $SPEC: run npx tauri ios init first." >&2; exit 1; }
VERSION=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' src-tauri/tauri.conf.json)

python3 - "$SPEC" "$VERSION" <<'PY'
import sys
path, version = sys.argv[1], sys.argv[2]
spec = open(path).read()
if "folio_Share:" in spec:
    print("The share extension is already in the project.")
    sys.exit(0)

def once(old, new):
    global spec
    if spec.count(old) != 1:
        sys.exit(f"Unexpected project.yml (looking for {old!r}); add the share extension by hand.")
    spec = spec.replace(old, new)

# The app: the App Group, and the extension built and embedded with it.
once("      path: folio_iOS/folio_iOS.entitlements\n",
     "      path: folio_iOS/folio_iOS.entitlements\n"
     "      properties:\n"
     "        com.apple.security.application-groups: [group.dev.folio.app]\n")
once("    dependencies:\n", "    dependencies:\n      - target: folio_Share\n")

if not spec.endswith("\n"):
    spec += "\n"
# targets: is the last key of Tauri's project.yml.
spec += f"""  folio_Share:
    type: app-extension
    platform: iOS
    sources:
      - path: ../../ios-share
    info:
      path: folio_Share/Info.plist
      properties:
        CFBundleDisplayName: Folio
        CFBundleShortVersionString: {version}
        CFBundleVersion: "{version}"
        NSExtension:
          NSExtensionPointIdentifier: com.apple.share-services
          NSExtensionPrincipalClass: $(PRODUCT_MODULE_NAME).ShareViewController
          NSExtensionAttributes:
            NSExtensionActivationRule:
              NSExtensionActivationSupportsText: true
              NSExtensionActivationSupportsWebURLWithMaxCount: 1
    entitlements:
      path: folio_Share/folio_Share.entitlements
      properties:
        com.apple.security.application-groups: [group.dev.folio.app]
    settings:
      base:
        PRODUCT_NAME: FolioShare
        PRODUCT_BUNDLE_IDENTIFIER: dev.folio.app.share
        SWIFT_VERSION: "5.0"
        ARCHS: [arm64]
        TARGETED_DEVICE_FAMILY: "1,2"
"""
open(path, "w").write(spec)
print("Added the share extension to the project.")
PY

(cd src-tauri/gen/apple && xcodegen generate --quiet)
