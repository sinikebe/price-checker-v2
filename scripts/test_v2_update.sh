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
# Older main revisions keep Dockerfile.web outside the frontend build context.
export COMPOSE_BAKE=false
export PRICE_CHECKER_V2_DATA_DIR=$sandbox/data
# Do not mask the host's real private dev while exercising disposable instances.
export PRICE_CHECKER_V2_MAINTENANCE_MARKER=$sandbox/maintenance
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

# On a PR merge commit, start from the preceding feature-branch revision.
# Push builds use the previous installed SHA supplied by the workflow.
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=safe.directory
export GIT_CONFIG_VALUE_0=$source_dir
base_ref="${V2_UPGRADE_BASE_REF:-}"
if [[ -z "$base_ref" || "$base_ref" =~ ^0+$ ]]; then
  if git -C "$source_dir" rev-parse --verify HEAD^2 >/dev/null 2>&1; then
    base_ref=HEAD^2^
  else
    base_ref=HEAD^
  fi
fi
base=$(git -C "$source_dir" rev-parse "$base_ref")
head=$(git -C "$source_dir" rev-parse HEAD)
git init --bare -q "$bare"
git -C "$source_dir" push -q "$bare" "$base:refs/heads/main"
git clone -q --single-branch --branch main "$bare" "$repo"

"$repo/deployment/v2/install.sh"
"${compose[@]}" exec -T db psql -v ON_ERROR_STOP=1 -U v2_ci_update -d v2_ci_update <<'SQL'
INSERT INTO v2_users (username, username_key, password_hash, role)
VALUES ('ci_upgrade', 'ci_upgrade', 'unused-ci-hash', 'visitor');
INSERT INTO v2_products (data)
VALUES ('{"name":"CI upgrade sentinel","brand":"CI","quantity":"100 g"}');
INSERT INTO v2_product_drafts (author_id, data)
SELECT id, '{"name":"CI private draft","brand":"CI"}'
FROM v2_users WHERE username_key='ci_upgrade';
INSERT INTO v2_recipes (author_id, title, base_servings, steps)
SELECT id, 'CI upgrade recipe', 2, '["Mix"]'::jsonb
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
before=$("${compose[@]}" exec -T db psql -At -U v2_ci_update -d v2_ci_update -c "SELECT (SELECT count(*) FROM v2_users WHERE username_key='ci_upgrade'), (SELECT count(*) FROM v2_products WHERE data->>'name'='CI upgrade sentinel'), (SELECT count(*) FROM v2_product_drafts WHERE data->>'name'='CI private draft'), (SELECT count(*) FROM v2_recipes WHERE title='CI upgrade recipe'), (SELECT count(*) FROM v2_price_observations WHERE price=12.34);")
[[ $before == "1|1|1|1|1" ]] || { echo "Fixture was not seeded: $before" >&2; exit 1; }

git -C "$source_dir" push -q "$bare" "$head:refs/heads/main"
PRICE_CHECKER_V2_EXPECTED_SHA=$head "$repo/deployment/v2/update.sh"
[[ $(git -C "$repo" rev-parse HEAD) == "$head" ]] || { echo "Updater did not install candidate commit." >&2; exit 1; }
"${compose[@]}" run --rm --no-deps -e V2_ROLE_PROBE=1 backend python -m app.db.v2_roles
"${compose[@]}" run --rm --no-deps \
  -v "$PRICE_CHECKER_V2_DATA_DIR/postgres/migration.json:/migration/database.json:ro" \
  -e PRICE_CHECKER_V2_STATE_DIR=/migration backend python -m app.db.v2_migrations
after=$("${compose[@]}" exec -T db psql -At -U v2_ci_update -d v2_ci_update -c "SELECT (SELECT count(*) FROM v2_users WHERE username_key='ci_upgrade'), (SELECT count(*) FROM v2_products WHERE data->>'name'='CI upgrade sentinel'), (SELECT count(*) FROM v2_product_drafts WHERE data->>'name'='CI private draft'), (SELECT count(*) FROM v2_recipes WHERE title='CI upgrade recipe'), (SELECT count(*) FROM v2_price_observations WHERE price=12.34);")
[[ $after == "$before" ]] || { echo "Data changed across update: $before -> $after" >&2; exit 1; }
remaining_basket_table=$("${compose[@]}" exec -T db psql -At -U v2_ci_update -d v2_ci_update -c "SELECT to_regclass('v2_user_baskets') IS NULL")
[[ $remaining_basket_table == t ]] || { echo "Obsolete server basket table remains after update." >&2; exit 1; }
for basket_path in basket basket/legacy; do
  status=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PRICE_CHECKER_V2_PORT/api/v2/$basket_path")
  [[ $status == 404 ]] || { echo "Obsolete server basket endpoint remains: $basket_path ($status)" >&2; exit 1; }
done
curl -fsS "http://127.0.0.1:$PRICE_CHECKER_V2_PORT/api/v2/auth/status" >/dev/null
curl -fsS "http://127.0.0.1:$PRICE_CHECKER_V2_PORT/api/v2/products/1" |
  python3 -c 'import json,sys; assert json.load(sys.stdin)["data"]["name"] == "CI upgrade sentinel"'
backup=$(find "$PRICE_CHECKER_V2_DATA_DIR/backups" -name '*.dump' -size +0c -print -quit)
[[ -n $backup ]] || { echo "Updater did not create a backup." >&2; exit 1; }
"${compose[@]}" exec -T db createdb -U v2_ci_update v2_ci_restore
"${compose[@]}" exec -T db pg_restore -U v2_ci_update --no-owner --no-acl -d v2_ci_restore < "$backup"
restored=$("${compose[@]}" exec -T db psql -At -U v2_ci_update -d v2_ci_restore -c "SELECT (SELECT count(*) FROM v2_users WHERE username_key='ci_upgrade'), (SELECT count(*) FROM v2_products WHERE data->>'name'='CI upgrade sentinel'), (SELECT count(*) FROM v2_product_drafts WHERE data->>'name'='CI private draft'), (SELECT count(*) FROM v2_recipes WHERE title='CI upgrade recipe'), (SELECT count(*) FROM v2_price_observations WHERE price=12.34);")
[[ $restored == "$before" ]] || { echo "Backup restore lost data: $before -> $restored" >&2; exit 1; }
"${compose[@]}" exec -T db dropdb -U v2_ci_update v2_ci_restore
echo "Upgrade smoke passed: installed $head, account/product/draft/recipe/price retained, backup restored, API healthy."
