#!/usr/bin/env bash
set -euo pipefail

[[ ${EUID} -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ -f "$repo_dir/.env" ]] || { echo "V2 is not installed." >&2; exit 1; }
set -a
source "$repo_dir/.env"
set +a
[[ "$PRICE_CHECKER_V2_ENV" == dev || "$PRICE_CHECKER_V2_ENV" == prod ]] || {
  echo "Invalid V2 environment." >&2; exit 1;
}
[[ "$repo_dir" == /opt/price-checker-v2/source ]] || {
  echo "Install the scheduler from the installed checkout." >&2; exit 1;
}
[[ -d "$PRICE_CHECKER_V2_DATA_DIR/state" ]] || {
  echo "V2 state directory is missing." >&2; exit 1;
}
unit="price-checker-v2-$PRICE_CHECKER_V2_ENV-update"
service="/etc/systemd/system/$unit.service"
timer="/etc/systemd/system/$unit.timer"
tmp_service="$(mktemp)"
tmp_timer="$(mktemp)"
trap 'rm -f "$tmp_service" "$tmp_timer"' EXIT
cat > "$tmp_service" <<EOF
[Unit]
Description=Check scheduled Price Checker V2 $PRICE_CHECKER_V2_ENV update
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=$repo_dir/.env
WorkingDirectory=$repo_dir
ExecStart=/usr/bin/python3 $repo_dir/deployment/v2/scheduled_update.py
EOF
cat > "$tmp_timer" <<EOF
[Unit]
Description=Check Price Checker V2 $PRICE_CHECKER_V2_ENV update schedule every minute

[Timer]
OnCalendar=*-*-* *:*:00
AccuracySec=10s
Persistent=false
Unit=$unit.service

[Install]
WantedBy=timers.target
EOF
for pair in "$tmp_service:$service" "$tmp_timer:$timer"; do
  source_file="${pair%%:*}"
  destination="${pair#*:}"
  if [[ -e "$destination" ]] && ! cmp -s "$source_file" "$destination"; then
    echo "Existing $destination differs; inspect and merge manually." >&2
    exit 1
  fi
done
install -m 0644 "$tmp_service" "$service"
install -m 0644 "$tmp_timer" "$timer"
systemctl daemon-reload
install -m 0644 /dev/null "$PRICE_CHECKER_V2_DATA_DIR/state/update-scheduler-installed"
systemctl enable --now "$unit.timer"
echo "Installed $unit.timer. Schedule remains disabled until enabled by an administrator."
