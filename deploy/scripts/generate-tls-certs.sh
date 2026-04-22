#!/usr/bin/env bash

set -euo pipefail

deploy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cert_dir="${deploy_dir}/state/caddy/certs"
ca_key="${cert_dir}/smart-db-root-ca.key"
ca_crt="${cert_dir}/smart-db-root-ca.crt"
server_key="${cert_dir}/server.key"
server_csr="${cert_dir}/server.csr"
server_crt="${cert_dir}/server.crt"
openssl_config="${cert_dir}/server-openssl.cnf"

# Parse --ip flags (repeatable). Default to prod IPs if none given.
IPS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ip) IPS+=("$2"); shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done
if [ ${#IPS[@]} -eq 0 ]; then
  IPS=("10.42.200.4" "10.42.200.136")
fi

install -d -m 700 "${cert_dir}"

if [ ! -f "${ca_key}" ] || [ ! -f "${ca_crt}" ]; then
  openssl req -x509 -new -nodes -newkey rsa:4096 \
    -keyout "${ca_key}" \
    -out "${ca_crt}" \
    -sha256 \
    -days 3650 \
    -subj "/CN=Smart DB Local Root CA"
  chmod 600 "${ca_key}"
  chmod 644 "${ca_crt}"
fi

# Build the [alt_names] section from the --ip arguments
ALT_NAMES=""
for i in "${!IPS[@]}"; do
  ALT_NAMES+="IP.$((i+1)) = ${IPS[$i]}"$'\n'
done

cat > "${openssl_config}" <<EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
req_extensions = req_ext
distinguished_name = dn

[dn]
CN = Smart DB Local Server

[req_ext]
subjectAltName = @alt_names
extendedKeyUsage = serverAuth

[alt_names]
${ALT_NAMES}
EOF

openssl req -new -nodes -newkey rsa:2048 \
  -keyout "${server_key}" \
  -out "${server_csr}" \
  -config "${openssl_config}"

openssl x509 -req \
  -in "${server_csr}" \
  -CA "${ca_crt}" \
  -CAkey "${ca_key}" \
  -CAcreateserial \
  -out "${server_crt}" \
  -days 825 \
  -sha256 \
  -extensions req_ext \
  -extfile "${openssl_config}"

chmod 600 "${server_key}"
chmod 644 "${server_crt}"
rm -f "${server_csr}" "${openssl_config}"

echo "Cert generated for: ${IPS[*]}"
echo "  CA:     ${ca_crt}"
echo "  Server: ${server_crt}"
