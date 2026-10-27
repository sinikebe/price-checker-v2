#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
source_dir=$(cd "$(dirname "$0")/.." && pwd)
sandbox=$(mktemp -d /tmp/price-checker-v2-fresh-ci-XXXXXX)
bare=$sandbox/origin.git
repo=$sandbox/source
export PRICE_CHECKER_V2_ENV=dev
export PRICE_CHECKER_V2_DATA_DIR=$sandbox/data
export PRICE_CHECKER_V2_DB_NAME=v2_ci_fresh
export PRICE_CHECKER_V2_PORT=18084
export COMPOSE_PROJECT_NAME=price-checker-v2-ci-fresh-$$
compose=(docker compose --env-file "$repo/.env" -f "$repo/deployment/v2/compose.yaml")
cleanup() {
  result=$?
  trap - EXIT
  if [[ -f "$repo/.env" ]]; then
    if [[ $result -ne 0 ]]; then "${compose[@]}" logs --tail=80 >&2 || true; fi
    "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  [[ $sandbox == /tmp/price-checker-v2-fresh-ci-* ]] && rm -rf -- "$sandbox"
  exit "$result"
}
trap cleanup EXIT
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=safe.directory
export GIT_CONFIG_VALUE_0=$source_dir
head=$(git -C "$source_dir" rev-parse HEAD)
git init --bare -q "$bare"
git -C "$source_dir" push -q "$bare" "$head:refs/heads/main"
git clone -q --branch main "$bare" "$repo"
printf 'PRICE_CHECKER_V2_ENV=dev\nPRICE_CHECKER_V2_DATA_DIR=relative\n' > "$repo/.env"
if "$repo/deployment/v2/install.sh" > "$sandbox/invalid-install.log" 2>&1; then
  echo "Installer accepted an invalid saved data directory." >&2; exit 1
fi
grep -q 'Data directory must be an absolute path' "$sandbox/invalid-install.log" || {
  cat "$sandbox/invalid-install.log" >&2; exit 1;
}
[[ ! -d "$sandbox/data" ]] || { echo "Invalid saved configuration created state." >&2; exit 1; }
rm "$repo/.env"
"$repo/deployment/v2/install.sh"
config=$PRICE_CHECKER_V2_DATA_DIR/state/database.json
python3 - "$config" "$PRICE_CHECKER_V2_DB_NAME" <<'PY'
import json
import sys
with open(sys.argv[1]) as source:
    config = json.load(source)
assert config["username"] == sys.argv[2] + "_app"
PY
"${compose[@]}" run --rm --no-deps -e V2_ROLE_PROBE=1 backend python -m app.db.v2_roles
fresh_basket_table=$("${compose[@]}" exec -T db psql -At -U v2_ci_fresh -d v2_ci_fresh -c "SELECT to_regclass('v2_user_baskets') IS NULL")
[[ $fresh_basket_table == t ]] || { echo "Fresh install created an obsolete server basket table." >&2; exit 1; }
curl -fsS "http://127.0.0.1:$PRICE_CHECKER_V2_PORT/api/v2/auth/status" |
  python3 -c 'import json,sys; assert json.load(sys.stdin)["admin_initialized"] is False'
python3 - "$PRICE_CHECKER_V2_DATA_DIR/state/access-code" "$sandbox/bootstrap.json" <<'PYBOOT'
import json
import os
import sys
with open(sys.argv[1]) as source:
    code = source.read().strip()
with open(sys.argv[2], "w") as target:
    json.dump({"access_code": code, "password": "ci-bootstrap-password"}, target)
os.chmod(sys.argv[2], 0o600)
PYBOOT
curl -fsS -H "Content-Type: application/json"   --data-binary @"$sandbox/bootstrap.json"   "http://127.0.0.1:$PRICE_CHECKER_V2_PORT/api/v2/auth/admin" |
  python3 -c 'import json,sys; assert json.load(sys.stdin)["role"] == "admin"'
curl -fsS "http://127.0.0.1:$PRICE_CHECKER_V2_PORT/api/v2/auth/status" |
  python3 -c 'import json,sys; assert json.load(sys.stdin)["admin_initialized"] is True'
echo "Fresh install smoke passed: limited app role, API and admin bootstrap healthy."
