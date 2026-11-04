#!/bin/sh
# Folio's own macOS signing certificate (design/ARCHITECTURE.md §7.3).
#
# macOS remembers what an app may do (open the library in Documents, read
# its keys in the keychain) by the app's signature. Without a certificate
# every build is signed by its own hash, so each new version is a stranger
# and asks again. Signed with one certificate, every build is the same app.
#
# This makes the certificate once (self-signed, for code signing only) in
# ~/.folio-signing/ and puts it in the login keychain, where builds find
# it as "Folio Code Signing". Run it yourself, once per Mac that builds.
# For the release builds, add it to the repository secrets as well:
#   base64 -i ~/.folio-signing/macos.p12 | gh secret set APPLE_CERTIFICATE
#   gh secret set APPLE_CERTIFICATE_PASSWORD < ~/.folio-signing/macos-password.txt
# Keep ~/.folio-signing/ backed up: a new certificate is a new app to macOS
# (one more round of asking).
set -eu

dir="${FOLIO_SIGNING_DIR:-$HOME/.folio-signing}"
name="Folio Code Signing"
mkdir -p "$dir"
chmod 700 "$dir"
umask 077

if [ ! -f "$dir/macos.p12" ]; then
  conf=$(mktemp)
  cat > "$conf" <<CNF
[req]
distinguished_name = dn
prompt = no
x509_extensions = ext
[dn]
CN = $name
O = Folio
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
CNF
  openssl rand -base64 24 | tr -d '\n' > "$dir/macos-password.txt"
  openssl req -x509 -newkey rsa:3072 -sha256 -days 10000 -nodes -keyout "$dir/macos.key" -out "$dir/macos.pem" -config "$conf"
  openssl pkcs12 -export -legacy -inkey "$dir/macos.key" -in "$dir/macos.pem" -name "$name" -out "$dir/macos.p12" -passout "file:$dir/macos-password.txt"
  rm -f "$conf"
fi

if security find-identity -p codesigning | grep -q "\"$name\""; then
  echo "\"$name\" is already in the keychain."
else
  # Only codesign may use the key without asking.
  security import "$dir/macos.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$(cat "$dir/macos-password.txt")" -T /usr/bin/codesign
fi
security find-identity -p codesigning | grep "\"$name\""
