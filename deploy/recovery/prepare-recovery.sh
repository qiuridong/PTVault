#!/usr/bin/env bash
#
# PT Cloud Vault — operator-side recovery-key preparation (Bash / macOS / Linux).
#
# Run this on YOUR OWN computer, never on the VPS. It:
#   1. generates an age keypair locally,
#   2. writes ONLY the public recipient (age1...) for you to enroll on the VPS,
#   3. wraps the private key in a passphrase-encrypted escrow (age scrypt),
#   4. verifies the escrow decrypts back to the SAME recipient,
#   5. removes temporary plaintext keys (physical erasure is not guaranteed).
#
# The plaintext private key and your passphrase never leave this machine and
# never appear in argv or logs. Keys temporarily exist in a private directory.
# age itself reads the passphrase from the controlling terminal.
#
# Usage:  ./prepare-recovery.sh [output-directory]
#   output-directory defaults to ./ptvault-recovery
#
# After it finishes, upload TWO things to your VPS enrollment step:
#   - recovery-recipient.txt   (safe to share; this is the public key)
#   - recovery-key.age         (the passphrase-encrypted private key escrow)
# Keep recovery-key.age AND your passphrase somewhere safe and separate. Losing
# both means the cloud copies can never be decrypted.

set -euo pipefail

AGE_KEYGEN_BIN="${PTVAULT_AGE_KEYGEN_BIN:-age-keygen}"
AGE_BIN="${PTVAULT_AGE_BIN:-age}"

OUT_DIR="${1:-./ptvault-recovery}"

RECIPIENT_FILE="$OUT_DIR/recovery-recipient.txt"
ESCROW_FILE="$OUT_DIR/recovery-key.age"

if [ -e "$OUT_DIR" ] || [ -L "$OUT_DIR" ]; then
  echo 'recovery: output directory already exists; choose a new directory' >&2
  exit 1
fi
if ! ( : </dev/tty ) 2>/dev/null; then
  echo 'recovery: an interactive terminal is required (do not pipe a passphrase)' >&2
  exit 1
fi
umask 077

# Everything sensitive lives in a 0700 temp dir wiped on every exit path.
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ptvault-recovery.XXXXXX")"
chmod 700 "$TMP_DIR"

KEY_FILE="$TMP_DIR/identity.age.key"
ROUNDTRIP_FILE="$TMP_DIR/roundtrip.key"
ESCROW_TMP="$TMP_DIR/recovery-key.age"

cleanup() {
  # Best-effort secure wipe of any plaintext key material before removal.
  for f in "$KEY_FILE" "$ROUNDTRIP_FILE"; do
    [ -f "$f" ] || continue
    if command -v shred >/dev/null 2>&1; then
      shred -u "$f" 2>/dev/null || rm -f "$f"
    else
      # overwrite then unlink where shred is unavailable (e.g. macOS)
      dd if=/dev/zero of="$f" bs=1024 count=8 conv=notrunc 2>/dev/null || true
      rm -f "$f"
    fi
  done
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

die() {
  echo "recovery: $1" 1>&2
  exit 1
}

# 1. generate the keypair locally.
"$AGE_KEYGEN_BIN" -o "$KEY_FILE" >/dev/null 2>"$TMP_DIR/keygen.err" \
  || die "age-keygen failed"
chmod 600 "$KEY_FILE"

# 2. derive the public recipient from the just-generated secret key.
RECIPIENT="$("$AGE_KEYGEN_BIN" -y "$KEY_FILE")"
case "$RECIPIENT" in
  age1*) : ;;
  *) die "could not derive a public recipient" ;;
esac

# 3. passphrase-encrypt the private key (age scrypt), staging the escrow inside
#    the 0700 temp dir. Real age prompts on /dev/tty, not stdin.
"$AGE_BIN" -p -o "$ESCROW_TMP" "$KEY_FILE" \
  || die "escrow encryption failed"

# 4. verify the escrow round-trips back to the SAME recipient before we trust it.
"$AGE_BIN" -d -o "$ROUNDTRIP_FILE" "$ESCROW_TMP" \
  || die "escrow failed to decrypt with the supplied passphrase"
ROUNDTRIP_RECIPIENT="$("$AGE_KEYGEN_BIN" -y "$ROUNDTRIP_FILE")"
[ "$ROUNDTRIP_RECIPIENT" = "$RECIPIENT" ] \
  || die "escrow verification mismatch — refusing to write output"

# 5. escrow is proven good → publish the outputs atomically.
mkdir "$OUT_DIR"
chmod 700 "$OUT_DIR" 2>/dev/null || true
printf '%s\n' "$RECIPIENT" > "$RECIPIENT_FILE"
chmod 600 "$RECIPIENT_FILE"
mv "$ESCROW_TMP" "$ESCROW_FILE"
chmod 600 "$ESCROW_FILE"

if command -v sha256sum >/dev/null 2>&1; then
  ESCROW_SHA="$(sha256sum "$ESCROW_FILE" | cut -d' ' -f1)"
else
  ESCROW_SHA="$(shasum -a 256 "$ESCROW_FILE" | cut -d' ' -f1)"
fi

cat <<EOF
Recovery material prepared.

  Public recipient : $RECIPIENT
  Recipient file   : $RECIPIENT_FILE
  Escrow file      : $ESCROW_FILE
  Escrow SHA-256   : $ESCROW_SHA

Next steps:
  1. Enroll the PUBLIC recipient on the VPS (paste $RECIPIENT into the
     recovery-recipient setup, or upload recovery-recipient.txt). This is safe
     to share.
  2. Store recovery-key.age AND your passphrase somewhere safe and SEPARATE from
     the VPS. You need both to decrypt cloud copies on a clean machine.
  3. Never upload plaintext keys. Temporary keys were removed; physical erasure
     is not guaranteed on SSDs, snapshots, or backed-up filesystems.
EOF

