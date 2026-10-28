#!/usr/bin/env bash
set -euo pipefail

# Run from a clean checkout of the main branch.
if [[ ${EUID} -ne 0 ]]; then
  echo "Run as root (sudo); this script prepares protected server state." >&2
  exit 1
fi
for tool in docker openssl curl git python3; do
  command -v "$tool" >/dev/null || { echo "Missing: $tool" >&2; exit 1; }
done
docker compose version >/dev/null || { echo "Docker Compose plugin is required" >&2; exit 1; }

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repo_dir/deployment/v2/compose.yaml"
# The saved instance configuration is authoritative on reruns. Validate the
# effective values before creating state or starting Docker containers.
if [[ -f "$repo_dir/.env" ]]; then
  source "$repo_dir/.env"
fi
source_branch="$(git -C "$repo_dir" branch --show-current)"
[[ -z "$(git -C "$repo_dir" status --porcelain)" ]] || {
  echo "Checkout must be clean." >&2; exit 1;
}
[[ -f "$repo_dir/backend/app/main_v2.py" && -f "$repo_dir/frontend/v2.html" ]] || {
  echo "This commit has no V2-only deployment." >&2; exit 1;
}
export PRICE_CHECKER_V2_ENV="${PRICE_CHECKER_V2_ENV:-prod}"
[[ "$PRICE_CHECKER_V2_ENV" == dev || "$PRICE_CHECKER_V2_ENV" == prod ]] || {
  echo "PRICE_CHECKER_V2_ENV must be dev or prod." >&2; exit 1;
}
[[ "$source_branch" == main ||
   ( "$PRICE_CHECKER_V2_ENV" == dev && "$source_branch" == dev ) ]] || {
  echo "Installation requires main, or dev for a private development instance." >&2; exit 1;
}
default_data_dir="/var/lib/price-checker-v2"
if [[ "$PRICE_CHECKER_V2_ENV" == dev ]]; then default_data_dir+="-dev"; fi
export PRICE_CHECKER_V2_DATA_DIR="${PRICE_CHECKER_V2_DATA_DIR:-$default_data_dir}"
export PRICE_CHECKER_V2_DB_NAME="${PRICE_CHECKER_V2_DB_NAME:-pricechecker_v2_$PRICE_CHECKER_V2_ENV}"
export PRICE_CHECKER_V2_PORT="${PRICE_CHECKER_V2_PORT:-8080}"
export PRICE_CHECKER_V2_GIT_BRANCH="${PRICE_CHECKER_V2_GIT_BRANCH:-$source_branch}"
[[ "$PRICE_CHECKER_V2_GIT_BRANCH" == "$source_branch" ]] || {
  echo "Update branch must match the installed checkout." >&2; exit 1;
}
[[ "$PRICE_CHECKER_V2_DATA_DIR" =~ ^/[A-Za-z0-9/_-]+$ ]] || {
  echo "Data directory must be an absolute path without spaces." >&2; exit 1;
}
[[ "$PRICE_CHECKER_V2_DB_NAME" =~ ^[a-z][a-z0-9_]*$ ]] || {
  echo "Invalid V2 database name." >&2; exit 1;
}
[[ "$PRICE_CHECKER_V2_PORT" =~ ^[0-9]{2,5}$ ]] || {
  echo "Invalid V2 port." >&2; exit 1;
}
if [[ ! -f "$repo_dir/.env" ]]; then
  printf 'PRICE_CHECKER_V2_ENV=%s\nPRICE_CHECKER_V2_DATA_DIR=%s\nPRICE_CHECKER_V2_DB_NAME=%s\nPRICE_CHECKER_V2_PORT=%s\n' \
    "$PRICE_CHECKER_V2_ENV" "$PRICE_CHECKER_V2_DATA_DIR" "$PRICE_CHECKER_V2_DB_NAME" "$PRICE_CHECKER_V2_PORT" > "$repo_dir/.env"
  printf 'PRICE_CHECKER_V2_GIT_BRANCH=%s\n' "$PRICE_CHECKER_V2_GIT_BRANCH" >> "$repo_dir/.env"
  chmod 0600 "$repo_dir/.env"
fi
export PRICE_CHECKER_V2_ENV PRICE_CHECKER_V2_DATA_DIR PRICE_CHECKER_V2_DB_NAME PRICE_CHECKER_V2_PORT
# Production legal text belongs to this instance, never to the checkout/image.
if [[ "$PRICE_CHECKER_V2_ENV" == prod ]]; then
  python3 "$repo_dir/deployment/v2/check-legal-docs.py" "$PRICE_CHECKER_V2_DATA_DIR/state/legal" --backend-access
fi
compose=(docker compose --env-file "$repo_dir/.env" -f "$compose_file")
install -d -m 0700 "$PRICE_CHECKER_V2_DATA_DIR"
install -d -m 0755 "$PRICE_CHECKER_V2_DATA_DIR/certs"
install -d -m 0700 "$PRICE_CHECKER_V2_DATA_DIR/postgres" "$PRICE_CHECKER_V2_DATA_DIR/backups"
install -d -m 0700 "$PRICE_CHECKER_V2_DATA_DIR/state"
chown 1000:1000 "$PRICE_CHECKER_V2_DATA_DIR/state"
pg_uid="$(docker run --rm postgres:16-alpine id -u postgres)"
pg_gid="$(docker run --rm postgres:16-alpine id -g postgres)"
if [[ ! -e "$PRICE_CHECKER_V2_DATA_DIR/postgres/password" ]]; then
  umask 077
  openssl rand -base64 48 > "$PRICE_CHECKER_V2_DATA_DIR/postgres/password"
fi
chown "$pg_uid:$pg_gid" "$PRICE_CHECKER_V2_DATA_DIR/postgres/password"
chmod 0600 "$PRICE_CHECKER_V2_DATA_DIR/postgres/password"
if [[ ! -e "$PRICE_CHECKER_V2_DATA_DIR/certs/server.crt" || ! -e "$PRICE_CHECKER_V2_DATA_DIR/certs/server.key" ]]; then
  [[ ! -e "$PRICE_CHECKER_V2_DATA_DIR/certs/server.crt" && ! -e "$PRICE_CHECKER_V2_DATA_DIR/certs/server.key" ]] || {
    echo "Incomplete existing TLS certificate; refusing to replace it." >&2; exit 1;
  }
  umask 077
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 825 \
    -subj "/CN=db" -addext "subjectAltName=DNS:db" \
    -keyout "$PRICE_CHECKER_V2_DATA_DIR/certs/server.key" \
    -out "$PRICE_CHECKER_V2_DATA_DIR/certs/server.crt" >/dev/null 2>&1
fi
chown "$pg_uid:$pg_gid" "$PRICE_CHECKER_V2_DATA_DIR/certs/server.key"
chmod 0600 "$PRICE_CHECKER_V2_DATA_DIR/certs/server.key"
chmod 0644 "$PRICE_CHECKER_V2_DATA_DIR/certs/server.crt"

"${compose[@]}" build backend
"${compose[@]}" build web
"${compose[@]}" up -d --wait db
if [[ ! -f "$PRICE_CHECKER_V2_DATA_DIR/state/database.json" ]]; then
  python3 - "$PRICE_CHECKER_V2_DATA_DIR" "$PRICE_CHECKER_V2_DB_NAME" <<'PYCONFIG'
import json
import os
import sys
from pathlib import Path
directory, name = Path(sys.argv[1]), sys.argv[2]
config = {
    "provider": "postgres", "project_url": "", "public_hostname": "",
    "host": "db", "port": 5432, "database": name, "username": name,
    "password": (directory / "postgres" / "password").read_text().strip(),
    "tls_mode": "verify-full",
}
path = directory / "state" / "database.json"
path.write_text(json.dumps(config))
os.chown(path, 1000, 1000)
os.chmod(path, 0o600)
PYCONFIG
fi
local_owner=$(python3 - "$PRICE_CHECKER_V2_DATA_DIR/state/database.json" "$PRICE_CHECKER_V2_DB_NAME" <<'PYCONFIG'
import json
import sys
with open(sys.argv[1]) as source:
    config = json.load(source)
print(int(config.get("provider") == "postgres" and config.get("host") == "db"
          and config.get("database") == sys.argv[2]
          and config.get("username") == sys.argv[2]))
PYCONFIG
)
if [[ $local_owner == 1 ]]; then
  "${compose[@]}" run --rm --no-deps backend python -m app.db.v2_migrations
  "$repo_dir/deployment/v2/configure-local-db.sh"
fi
"${compose[@]}" up -d
for attempt in {1..30}; do
  if curl -fs http://127.0.0.1:$PRICE_CHECKER_V2_PORT/api/v2/setup/status >/dev/null 2>&1; then
    echo "V2 installed at loopback :$PRICE_CHECKER_V2_PORT. Configure HTTPS proxy before admin bootstrap."
    echo "Bundled PostgreSQL uses a limited application role; migration credentials stay outside the runtime mount."
    echo "Read the setup code locally after first API request: $PRICE_CHECKER_V2_DATA_DIR/state/access-code"
    if [[ -d /run/systemd/system ]]; then
      "$repo_dir/deployment/v2/install-host-health.sh" || echo "Host monitoring installation deferred." >&2
    fi
    exit 0
  fi
  sleep 2
done
echo "V2 failed its local health check; inspect docker compose logs." >&2
exit 1
