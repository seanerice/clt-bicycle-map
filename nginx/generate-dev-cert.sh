#!/usr/bin/env bash
# Generates a LOCAL, SELF-SIGNED TLS cert+key for api.bikemap.seanerice.dev
# into the git-ignored nginx/certs/ directory.
#
# This is purely a stand-in to prove out the nginx/docker-compose.prod.yml
# TLS wiring locally (story 8.3) — it is NOT the certificate prod actually
# uses. The real certificate is a Cloudflare Origin CA cert, issued by
# hand in the Cloudflare dashboard (not scriptable via AWS CLI or any
# other API this repo automates) and installed at the same mount path
# during story 8.7. Do not use the output of this script in production —
# browsers/clients will not trust a self-signed cert, and it is only
# expected to be trusted here via curl's -k / --insecure flag.
#
# Usage:
#   bash nginx/generate-dev-cert.sh
#
# Output:
#   nginx/certs/api.bikemap.seanerice.dev.crt
#   nginx/certs/api.bikemap.seanerice.dev.key

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_DIR="$SCRIPT_DIR/certs"
DOMAIN="api.bikemap.seanerice.dev"

mkdir -p "$CERT_DIR"

# Subject/SAN are supplied via a temp openssl config rather than
# `-subj "/CN=..."` — Git Bash/MSYS on Windows rewrites leading-"/"
# command-line arguments into Windows paths before openssl ever sees
# them, which mangles a `-subj` value. A config file sidesteps that
# entirely (and works the same on Linux/macOS).
OPENSSL_CNF="$(mktemp)"
trap 'rm -f "$OPENSSL_CNF"' EXIT

cat > "$OPENSSL_CNF" <<EOF
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = $DOMAIN

[v3_req]
subjectAltName = DNS:$DOMAIN
EOF

openssl req -x509 \
    -newkey rsa:2048 \
    -sha256 \
    -days 365 \
    -nodes \
    -keyout "$CERT_DIR/$DOMAIN.key" \
    -out "$CERT_DIR/$DOMAIN.crt" \
    -config "$OPENSSL_CNF"

echo "Generated self-signed dev cert (NOT for production use):"
echo "  $CERT_DIR/$DOMAIN.crt"
echo "  $CERT_DIR/$DOMAIN.key"
