#!/usr/bin/env bash
set -euo pipefail

# Exercise the guarded updater with a disposable Git remote, Compose project,
# PostgreSQL volume and data directory.
[[ $EUID -eq 0 ]] || { echo "Run this integration test as root." >&2; exit 1; }
for tool in docker git curl python3; do command -v "$tool" >/dev/null; done
source_dir=$(cd "$(dirname "$0")/.." && pwd)
sandbox=$(mktemp -d /tmp/price-checker-v2-ci-XXXXXX)
bare=$sandbox/origin.git
repo=$sandbox/source
export PRICE_CHECKER_V2_ENV=dev
export PRICE_CHECKER_V2_DATA_DIR=$sandbox/data
export PRICE_CHECKER_V2_DB_NAME=v2_ci_update
export PRICE_CHECKER_V2_PORT=18083
export COMPOSE_PROJECT_NAME=price-checker-v2-ci-update-$$
compose=(docker compose --env-file "$repo/.env" -f "$repo/deployment/v2/compose.yaml")
cleanup() {
  result=$?
  trap - EXIT
  if [[ -f "$repo/.env" ]]; then
    if [[ $result -ne 0 ]]; then "${compose[@]}" logs --tail=80 >&2 || true; fi
    "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  [[ $sandbox == /tmp/price-checker-v2-ci-* ]] && rm -rf -- "$sandbox"
  exit "$result"
}
trap cleanup EXIT

# GitHub's PR checkout is a test merge commit; its first parent is main.
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=safe.directory
export GIT_CONFIG_VALUE_0=$source_dir
base=$(git -C "$source_dir" rev-parse HEAD^)
head=$(git -C "$source_dir" rev-parse HEAD)
git init --bare -q "$bare"
git -C "$source_dir" push -q "$bare" "$base:refs/heads/main"
git clone -q --branch main "$bare" "$repo"

# The historical base keeps its Dockerfile outside the build context;
# Buildx 0.37+ refuses that layout. This exception applies only to the old
# install; the candidate update builds with normal entitlement checks.
BUILDX_BAKE_ENTITLEMENTS_FS=0 "$repo/deployment/v2/install.sh"
password_file=$PRICE_CHECKER_V2_DATA_DIR/postgres/password
config_file=$PRICE_CHECKER_V2_DATA_DIR/state/database.json
python3 - "$password_file" "$config_file" <<'PY'
import json
import os
import sys
with open(sys.argv[1], encoding="utf-8") as source:
    password = source.read().strip()
config = {
    "provider": "postgres", "project_url": "", "public_hostname": "",
    "host": "db", "port": 5432, "database": "v2_ci_update",
    "username": "v2_ci_update", "password": password, "tls_mode": "verify-full",
}
with open(sys.argv[2], "w", encoding="utf-8") as target:
    json.dump(config, target)
os.chown(sys.argv[2], 1000, 1000)
os.chmod(sys.argv[2], 0o600)
PY
"${compose[@]}" run --rm --no-deps backend python -m app.db.v2_migrations
"${compose[@]}" exec -T db psql -v ON_ERROR_STOP=1 -U v2_ci_update -d v2_ci_update <<'SQL'
INSERT INTO v2_users (username, username_key, password_hash, role)
VALUES ('ci_upgrade', 'ci_upgrade', 'unused-ci-hash', 'visitor');
INSERT INTO v2_products (data)
VALUES ('{"name":"CI upgrade sentinel","brand":"CI","quantity":"100 g"}');
INSERT INTO v2_product_drafts (author_id, data)
SELECT id, '{"name":"CI private draft","brand":"CI"}'
FROM v2_users WHERE username_key='ci_upgrade';
INSERT INTO v2_retailers (code, name) VALUES ('ci', 'CI retailer');
INSERT INTO v2_stores (retailer_id, name)
SELECT id, 'CI store' FROM v2_retailers WHERE code='ci';
INSERT INTO v2_price_observations
(product_id, retailer_id, store_id, source, price, observed_at)
SELECT p.id, r.id, s.id, 'manual', 12.34, now()
FROM v2_products p CROSS JOIN v2_retailers r
JOIN v2_stores s ON s.retailer_id=r.id
WHERE p.data->>'name'='CI upgrade sentinel' AND r.code='ci';
SQL
before=$("${compose[@]}" exec -T db psql -At -U v2_ci_update -d v2_ci_update -c "SELECT (SELECT count(*) FROM v2_users WHERE username_key='ci_upgrade'), (SELECT count(*) FROM v2_products WHERE data->>'name'='CI upgrade sentinel'), (SELECT count(*) FROM v2_product_drafts WHERE data->>'name'='CI private draft'), (SELECT count(*) FROM v2_price_observations WHERE price=12.34);")
[[ $before == "1|1|1|1" ]] || { echo "Fixture was not seeded: $before" >&2; exit 1; }

git -C "$source_dir" push -q "$bare" "$head:refs/heads/main"
PRICE_CHECKER_V2_EXPECTED_SHA=$head "$repo/deployment/v2/update.sh"
[[ $(git -C "$repo" rev-parse HEAD) == "$head" ]] || { echo "Updater did not install candidate commit." >&2; exit 1; }
after=$("${compose[@]}" exec -T db psql -At -U v2_ci_update -d v2_ci_update -c "SELECT (SELECT count(*) FROM v2_users WHERE username_key='ci_upgrade'), (SELECT count(*) FROM v2_products WHERE data->>'name'='CI upgrade sentinel'), (SELECT count(*) FROM v2_product_drafts WHERE data->>'name'='CI private draft'), (SELECT count(*) FROM v2_price_observations WHERE price=12.34);")
[[ $after == "$before" ]] || { echo "Data changed across update: $before -> $after" >&2; exit 1; }
curl -fsS "http://127.0.0.1:$PRICE_CHECKER_V2_PORT/api/v2/auth/status" >/dev/null
curl -fsS "http://127.0.0.1:$PRICE_CHECKER_V2_PORT/api/v2/products/1" |
  python3 -c 'import json,sys; assert json.load(sys.stdin)["data"]["name"] == "CI upgrade sentinel"'
find "$PRICE_CHECKER_V2_DATA_DIR/backups" -name '*.dump' -size +0c | grep -q .
echo "Upgrade smoke passed: installed $head, account/product/draft/price retained, backup present, API healthy."
