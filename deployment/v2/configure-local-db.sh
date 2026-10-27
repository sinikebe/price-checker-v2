#!/usr/bin/env bash
set -euo pipefail
# Called only for the bundled PostgreSQL database, after its migrations.
[[ $EUID -eq 0 ]] || { echo "Root required." >&2; exit 1; }
repo_dir=$(cd "$(dirname "$0")/../.." && pwd)
source "$repo_dir/.env"
data_dir=$PRICE_CHECKER_V2_DATA_DIR
db_name=$PRICE_CHECKER_V2_DB_NAME
[[ $db_name =~ ^[a-z][a-z0-9_]*$ ]] || exit 1
app_role="${db_name}_app"
compose=(docker compose --env-file "$repo_dir/.env" -f "$repo_dir/deployment/v2/compose.yaml")
install -d -m 0700 "$data_dir/postgres"
if [[ ! -s "$data_dir/postgres/app-password" ]]; then
  umask 077
  openssl rand -hex 32 > "$data_dir/postgres/app-password"
fi
chown 1000:1000 "$data_dir/postgres/app-password"
chmod 0600 "$data_dir/postgres/app-password"
python3 - "$data_dir" "$db_name" "$app_role" <<'PY'
import json
import os
import sys
import tempfile
from pathlib import Path

data_dir, database, role = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
state = data_dir / "state" / "database.json"
previous = json.loads(state.read_text()) if state.exists() else {}
base = {
    "provider": "postgres", "project_url": "",
    "public_hostname": previous.get("public_hostname", ""),
    "host": "db", "port": 5432, "database": database, "tls_mode": "verify-full",
}
owner = {**base, "username": database,
         "password": (data_dir / "postgres" / "password").read_text().strip()}
app = {**base, "username": role,
       "password": (data_dir / "postgres" / "app-password").read_text().strip()}
for path, value in ((data_dir / "postgres" / "migration.json", owner),
                    (data_dir / "postgres" / "app-pending.json", app)):
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".config-")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream)
        os.chown(temporary, 1000, 1000)
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
PY
"${compose[@]}" run --rm --no-deps \
  -v "$data_dir/postgres/migration.json:/migration/database.json:ro" \
  -v "$data_dir/postgres/app-password:/migration/app-password:ro" \
  -e PRICE_CHECKER_V2_STATE_DIR=/migration backend python -m app.db.v2_roles
"${compose[@]}" run --rm --no-deps \
  -v "$data_dir/postgres/app-pending.json:/migration/database.json:ro" \
  -e PRICE_CHECKER_V2_STATE_DIR=/migration -e V2_ROLE_PROBE=1 \
  backend python -m app.db.v2_roles
mv "$data_dir/postgres/app-pending.json" "$data_dir/state/database.json"
