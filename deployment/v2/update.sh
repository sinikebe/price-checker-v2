#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then echo "Run as root (sudo)." >&2; exit 1; fi
for tool in docker git curl flock; do
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
if [[ "$new_sha" == "$old_sha" ]]; then echo "Already current: $old_sha"; exit 0; fi
git -C "$repo_dir" merge-base --is-ancestor "$old_sha" "$new_sha" || {
  echo "origin/main is not a fast-forward; refusing update." >&2; exit 1;
}
for file in backend/app/main_v2.py frontend/v2.html deployment/v2/compose.yaml deployment/v2/update.sh; do
  git -C "$repo_dir" cat-file -e "$new_sha:$file" || {
    echo "New main lacks $file; refusing update." >&2; exit 1;
  }
done
backup="$PRICE_CHECKER_V2_DATA_DIR/backups/$(date -u +%Y%m%dT%H%M%SZ)-$old_sha.dump"
umask 077
"${compose[@]}" exec -T db pg_dump -U "$PRICE_CHECKER_V2_DB_NAME" -d "$PRICE_CHECKER_V2_DB_NAME" -Fc > "$backup"
[[ -s "$backup" ]] || { echo "Database backup failed." >&2; exit 1; }
echo "Database backup: $backup"
git -C "$repo_dir" merge --ff-only "$new_sha"
rollback() {
  echo "Update failed; restoring application commit $old_sha (database backup retained)." >&2
  git -C "$repo_dir" reset --hard "$old_sha"
  "${compose[@]}" build backend
  "${compose[@]}" build web
  "${compose[@]}" up -d --no-deps backend web
}
trap rollback ERR
"${compose[@]}" build backend
"${compose[@]}" build web
if [[ -f "$PRICE_CHECKER_V2_DATA_DIR/state/database.json" ]]; then
  "${compose[@]}" run --rm --no-deps backend python -m app.db.v2_migrations
fi
"${compose[@]}" up -d --no-deps backend web
healthy=0
for attempt in {1..30}; do
  if curl -fs http://127.0.0.1:$PRICE_CHECKER_V2_PORT/api/v2/setup/status >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done
[[ "$healthy" == 1 ]] || { echo "Health check failed." >&2; false; }
trap - ERR
echo "Updated V2: $old_sha -> $new_sha"
