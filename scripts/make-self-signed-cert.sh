#!/usr/bin/env bash
# Creates the one self-signed code-signing certificate that every macOS
# release of Cuewell is signed with, and prints what to paste into the
# repository secrets MAC_SELF_SIGN_P12 and MAC_SELF_SIGN_PASSWORD.
#
# Why: an ad-hoc signed app's designated requirement is its cdhash, which
# changes with every build, so macOS drops the Screen Recording and
# Microphone permissions after each update. Signed with one certificate,
# the requirement is `identifier "com.ankitchaudhary.cuewell" and
# certificate leaf = H"<certificate SHA-1>"`, which stays the same across
# versions. Gatekeeper still warns on first launch: the app is not notarized.
#
# Run this ONCE and keep the output folder safe (a password manager or an
# encrypted backup). A new certificate means a new requirement, so every
# user would have to allow Screen Recording again. Never commit the files.
#
# Usage: scripts/make-self-signed-cert.sh [output folder]
#   Default folder: ~/cuewell-self-sign (must be outside the repository).
#   MAC_SELF_SIGN_PASSWORD in the environment sets the .p12 password;
#   otherwise a random one is generated and printed.
#
# Needs openssl (LibreSSL from macOS or OpenSSL 3+). On macOS the script
# also imports the .p12 into a throwaway keychain to check that `security`
# (what the release workflow uses) can read it.

set -euo pipefail

NAME="Cuewell Self-Signed"
DAYS=3650
OUT_DIR="${1:-$HOME/cuewell-self-sign}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"

fail() {
  echo "Error: $*" >&2
  exit 1
}

command -v openssl >/dev/null 2>&1 || fail "openssl is not installed."

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd -P)"
case "$OUT_DIR/" in
  "$REPO_DIR/"*) fail "$OUT_DIR is inside the repository. Choose a folder outside it, so the key can never be committed." ;;
esac

P12="$OUT_DIR/cuewell-self-sign.p12"
CERT="$OUT_DIR/cuewell-self-sign.cer.pem"
B64="$OUT_DIR/cuewell-self-sign.p12.base64"
for file in "$P12" "$CERT" "$B64"; do
  if [ -e "$file" ]; then
    fail "$file already exists. Reuse that certificate: a new one would make every user allow Screen Recording again. Move it away first if you really want a new one."
  fi
done

if [ -n "${MAC_SELF_SIGN_PASSWORD:-}" ]; then
  PASSWORD="$MAC_SELF_SIGN_PASSWORD"
  PRINT_PASSWORD=0
else
  PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
  PRINT_PASSWORD=1
fi
export CUEWELL_P12_PASSWORD="$PASSWORD"

umask 077
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cuewell-cert.XXXXXX")"
KEYCHAIN=""
cleanup() {
  if [ -n "$KEYCHAIN" ]; then
    security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

cat > "$WORK/openssl.cnf" <<EOF
[ req ]
distinguished_name = dn
prompt = no
x509_extensions = codesign

[ dn ]
CN = $NAME

[ codesign ]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF

# The key only ever exists unencrypted in the private temp folder above.
openssl req -x509 -new -newkey rsa:3072 -nodes -sha256 -days "$DAYS" \
  -config "$WORK/openssl.cnf" -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null \
  || fail "openssl could not create the certificate."

# SHA-1/3DES, which macOS's `security import` reads. OpenSSL 3's default
# (AES and PBKDF2) is rejected by some macOS versions.
openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$NAME" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
  -passout env:CUEWELL_P12_PASSWORD -out "$WORK/cert.p12" \
  || fail "openssl could not write the .p12 file."

if command -v security >/dev/null 2>&1; then
  # create-keychain adds the keychain to the search list; cleanup deletes
  # it again, which also removes it from the list.
  KEYCHAIN="$WORK/check.keychain-db"
  KEYCHAIN_PASSWORD="$(openssl rand -hex 16)"
  security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
  security import "$WORK/cert.p12" -k "$KEYCHAIN" -P "$PASSWORD" -T /usr/bin/codesign >/dev/null \
    || fail "macOS could not import the .p12 file."
  security find-identity -p codesigning "$KEYCHAIN" | grep -qF "\"$NAME\"" \
    || fail "the imported certificate is not a code-signing identity."
  echo "Checked: macOS imports the .p12 as a code-signing identity."
fi

cp "$WORK/cert.p12" "$P12"
cp "$WORK/cert.pem" "$CERT"
openssl base64 -A -in "$P12" > "$B64"
chmod 600 "$P12" "$CERT" "$B64"

SHA1="$(openssl x509 -in "$CERT" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')"
EXPIRES="$(openssl x509 -in "$CERT" -noout -enddate | sed 's/^notAfter=//')"

echo
echo "Created \"$NAME\" (SHA-1 $SHA1, valid until $EXPIRES)."
echo "Files in $OUT_DIR:"
echo "  $(basename "$P12")         certificate and private key (keep it safe, never commit it)"
echo "  $(basename "$CERT")     certificate only (public)"
echo "  $(basename "$B64")  the value for MAC_SELF_SIGN_P12"
echo
echo "Add two repository secrets (Settings > Secrets and variables > Actions):"
echo
echo "MAC_SELF_SIGN_P12 (one line):"
cat "$B64"
echo
echo
if [ "$PRINT_PASSWORD" = 1 ]; then
  echo "MAC_SELF_SIGN_PASSWORD:"
  echo "$PASSWORD"
else
  echo "MAC_SELF_SIGN_PASSWORD: the value you set in MAC_SELF_SIGN_PASSWORD."
fi
echo
echo "Or with the GitHub CLI, from the repository folder:"
echo "  gh secret set MAC_SELF_SIGN_P12 < \"$B64\""
echo "  gh secret set MAC_SELF_SIGN_PASSWORD"
echo
echo "Release builds signed with it show this designated requirement:"
echo "  designated => identifier \"com.ankitchaudhary.cuewell\" and certificate leaf = H\"$(echo "$SHA1" | tr 'A-F' 'a-f')\""
