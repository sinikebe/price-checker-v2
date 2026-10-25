#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then echo "Run as root (sudo)." >&2; exit 1; fi
for tool in docker git curl flock python3 openssl; do
  command -v "$tool" >/dev/null || { echo "Missing: $tool" >&2; exit 1; }
done
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repo_dir/deployment/v2/compose.yaml"
[[ -f "$repo_dir/.env" ]] || { echo "Installation configuration missing." >&2; exit 1; }
set -a
source "$repo_dir/.env"
set +a
compose=(docker compose --env-file "$repo_dir/.env" -f "$compose_file")
[[ "$PRICE_CHECKER_V2_DATA_DIR" = /* && -d "$PRICE_CHECKER_V2_DATA_DIR/state" ]] || {
  echo "V2 is not installed." >&2; exit 1;
}
exec 9>"$PRICE_CHECKER_V2_DATA_DIR/update.lock"
flock -n 9 || { echo "Another V2 update is running." >&2; exit 1; }
[[ "$(git -C "$repo_dir" branch --show-current)" == main ]] || {
  echo "Update requires main." >&2; exit 1;
}
[[ -z "$(git -C "$repo_dir" status --porcelain)" ]] || {
  echo "Checkout has local changes; refusing update." >&2; exit 1;
}
old_sha="$(git -C "$repo_dir" rev-parse HEAD)"
git -C "$repo_dir" fetch origin main
new_sha="$(git -C "$repo_dir" rev-parse FETCH_HEAD)"
git -C "$repo_dir" merge-base --is-ancestor "$old_sha" "$new_sha" || {
  echo "origin/main is not a fast-forward; refusing update." >&2; exit 1;
}
for file in backend/app/main_v2.py frontend/v2.html deployment/v2/compose.yaml deployment/v2/update.sh; do
  git -C "$repo_dir" cat-file -e "$new_sha:$file" || {
    echo "New main lacks $file; refusing update." >&2; exit 1;
  }
done

config_file="$PRICE_CHECKER_V2_DATA_DIR/state/database.json"
bundled_db=1
if [[ -f "$config_file" ]]; then
  configured_target="$(python3 - "$config_file" <<'PYCONFIG'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    config = json.load(source)
print(config["host"], config["port"], config["database"], config["username"],
      config["tls_mode"], sep="\t")
PYCONFIG
)"
  IFS=$'\t' read -r db_host db_port db_name db_user db_tls <<< "$configured_target"
  if [[ "$db_host" != db || "$db_port" != 5432 ||
        "$db_name" != "$PRICE_CHECKER_V2_DB_NAME" ||
        "$db_user" != "$PRICE_CHECKER_V2_DB_NAME" ]]; then
    bundled_db=0
  fi
  [[ "$db_tls" == disable || "$db_tls" == require || "$db_tls" == verify-full ]] || {
    echo "Invalid configured database TLS mode." >&2; exit 1;
  }
fi
cert_dir="$PRICE_CHECKER_V2_DATA_DIR/certs"
renew_cert=0
if [[ "$bundled_db" == 1 ]] && ! openssl x509 -in "$cert_dir/server.crt" \
    -checkend $((60 * 86400)) -noout >/dev/null 2>&1; then
  renew_cert=1
fi
if [[ "$new_sha" == "$old_sha" && "$renew_cert" == 0 ]]; then
  echo "Already current: $old_sha"
  exit 0
fi

umask 077
backup="$PRICE_CHECKER_V2_DATA_DIR/backups/$(date -u +%Y%m%dT%H%M%SZ)-$old_sha.dump"
backup_part="$backup.part"
pgpass_file=""
cert_backup_dir=""
new_key=""
new_crt=""
cleanup() {
  [[ -z "$pgpass_file" ]] || rm -f "$pgpass_file"
  [[ -z "$new_key" ]] || rm -f "$new_key"
  [[ -z "$new_crt" ]] || rm -f "$new_crt"
  rm -f "$backup_part"
}
trap cleanup EXIT
if [[ "$bundled_db" == 1 ]]; then
  "${compose[@]}" exec -T db pg_dump -U "$PRICE_CHECKER_V2_DB_NAME" \
    -d "$PRICE_CHECKER_V2_DB_NAME" -Fc > "$backup_part"
else
  # The same configured host/database/user are used for the backup and migrations.
  # A short-lived pgpass file avoids putting the password in command arguments.
  pgpass_file="$(mktemp "$cert_dir/.pgpass.XXXXXXXX")"
  python3 - "$config_file" "$pgpass_file" <<'PYPASS'
import json
import os
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    config = json.load(source)
def escaped(value):
    return str(value).replace("\\", "\\\\").replace(":", "\\:")
with open(sys.argv[2], "w", encoding="utf-8") as target:
    target.write(":".join(escaped(config[key]) for key in
                          ("host", "port", "database", "username", "password")) + "\n")
os.chmod(sys.argv[2], 0o600)
PYPASS
  chown --reference="$cert_dir/server.key" "$pgpass_file"
  pg_env=(-e PGPASSFILE="/certs/${pgpass_file##*/}" -e PGSSLMODE="$db_tls")
  if [[ "$db_tls" == verify-full ]]; then
    pg_env+=(-e PGSSLROOTCERT=/etc/ssl/certs/ca-certificates.crt)
  fi
  "${compose[@]}" exec -T "${pg_env[@]}" db pg_dump \
    -h "$db_host" -p "$db_port" -U "$db_user" -d "$db_name" -Fc > "$backup_part"
  rm -f "$pgpass_file"
  pgpass_file=""
fi
[[ -s "$backup_part" ]] || { echo "Database backup failed." >&2; exit 1; }
"${compose[@]}" exec -T db pg_restore -l < "$backup_part" > /dev/null || {
  echo "Database backup is unreadable." >&2; exit 1;
}
mv "$backup_part" "$backup"
echo "Database backup: $backup"

rollback() {
  trap - ERR
  echo "Update failed; restoring application commit $old_sha (database backup retained)." >&2
  git -C "$repo_dir" reset --hard "$old_sha"
  if [[ -n "$cert_backup_dir" ]]; then
    cp -p "$cert_backup_dir/server.key" "$cert_dir/server.key"
    cp -p "$cert_backup_dir/server.crt" "$cert_dir/server.crt"
    "${compose[@]}" up -d --wait --no-deps --force-recreate db
  fi
  "${compose[@]}" build backend
  "${compose[@]}" build web
  "${compose[@]}" up -d --no-deps backend web
}
trap rollback ERR
git -C "$repo_dir" merge --ff-only "$new_sha"
"${compose[@]}" build backend
"${compose[@]}" build web
if [[ "$renew_cert" == 1 ]]; then
  pending_cert_backup_dir="$PRICE_CHECKER_V2_DATA_DIR/backups/db-cert-$(date -u +%Y%m%dT%H%M%SZ)-$old_sha"
  install -d -m 0700 "$pending_cert_backup_dir"
  cp -p "$cert_dir/server.key" "$pending_cert_backup_dir/server.key"
  cp -p "$cert_dir/server.crt" "$pending_cert_backup_dir/server.crt"
  cert_backup_dir="$pending_cert_backup_dir"
  new_key="$cert_dir/.server.key.new.$$"
  new_crt="$cert_dir/.server.crt.new.$$"
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 825 \
    -subj "/CN=db" -addext "subjectAltName=DNS:db" \
    -keyout "$new_key" -out "$new_crt" >/dev/null 2>&1
  chown --reference="$cert_dir/server.key" "$new_key"
  chmod 0600 "$new_key"
  chmod 0644 "$new_crt"
  "${compose[@]}" stop backend
  mv "$new_key" "$cert_dir/server.key"
  mv "$new_crt" "$cert_dir/server.crt"
  "${compose[@]}" up -d --wait --no-deps --force-recreate db
fi
if [[ -f "$config_file" ]]; then
  "${compose[@]}" run --rm --no-deps backend python -m app.db.v2_migrations
fi
"${compose[@]}" up -d --no-deps backend web
health_path=/api/v2/setup/status
if [[ -f "$config_file" ]]; then health_path=/api/v2/auth/status; fi
healthy=0
for attempt in {1..30}; do
  if curl -fs "http://127.0.0.1:$PRICE_CHECKER_V2_PORT$health_path" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done
[[ "$healthy" == 1 ]] || { echo "Health check failed." >&2; false; }
trap - ERR
if [[ "$renew_cert" == 1 ]]; then echo "Bundled database certificate renewed."; fi
echo "Updated V2: $old_sha -> $new_sha"
