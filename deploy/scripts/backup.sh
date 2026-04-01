#!/usr/bin/env bash

set -euo pipefail
umask 077

deploy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backup_root="${deploy_dir}/backups"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target_dir="${backup_root}/${timestamp}"
lock_file="${backup_root}/.backup.lock"
compose_cmd=(docker compose -f "${deploy_dir}/compose.yaml")
smart_db_dir="${deploy_dir}/state/smartdb/data"
partdb_db_dir="${deploy_dir}/state/partdb/db"
partdb_uploads_dir="${deploy_dir}/state/partdb/uploads"
partdb_media_dir="${deploy_dir}/state/partdb/public-media"
caddy_certs_dir="${deploy_dir}/state/caddy/certs"
config_dir="${deploy_dir}/config"

install -d -m 700 "${backup_root}"
exec 9>"${lock_file}"
flock -n 9 || {
  echo "backup already running" >&2
  exit 0
}

install -d -m 700 "${target_dir}"

if [ -f "${smart_db_dir}/smart.db" ]; then
  sqlite3 "${smart_db_dir}/smart.db" ".backup '${target_dir}/smart.db'"
fi

if [ -f "${partdb_db_dir}/app.db" ]; then
  sqlite3 "${partdb_db_dir}/app.db" ".backup '${target_dir}/partdb-app.db'"
fi

tar -czf "${target_dir}/partdb-uploads.tar.gz" -C "${partdb_uploads_dir}" .
tar -czf "${target_dir}/partdb-public-media.tar.gz" -C "${partdb_media_dir}" .
tar -czf "${target_dir}/caddy-certs.tar.gz" -C "${caddy_certs_dir}" .
tar -czf "${target_dir}/config.tar.gz" -C "${config_dir}" .
chmod 600 "${target_dir}"/*

{
  printf 'created_at=%s\n' "${timestamp}"
  printf 'compose_services=%s\n' "$("${compose_cmd[@]}" ps --services 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')"
  sha256sum "${target_dir}"/*
} > "${target_dir}/manifest.txt"

find "${backup_root}" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
