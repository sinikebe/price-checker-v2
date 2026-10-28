#!/usr/bin/env bash
set -euo pipefail

[[ ${EUID} -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "$repo_dir" == /opt/price-checker-v2/source && -f "$repo_dir/.env" ]] || {
  echo "Install host monitoring from the installed checkout." >&2; exit 1;
}
source "$repo_dir/.env"
[[ "$PRICE_CHECKER_V2_ENV" == dev || "$PRICE_CHECKER_V2_ENV" == prod ]] || {
  echo "Invalid V2 environment." >&2; exit 1;
}
[[ "$PRICE_CHECKER_V2_DATA_DIR" =~ ^/[A-Za-z0-9/_-]+$ && -d "$PRICE_CHECKER_V2_DATA_DIR/state" ]] || {
  echo "Invalid V2 state directory." >&2; exit 1;
}
unit="price-checker-v2-$PRICE_CHECKER_V2_ENV-host-health"
service="/etc/systemd/system/$unit.service"
timer="/etc/systemd/system/$unit.timer"
tmp_service="$(mktemp)"
tmp_timer="$(mktemp)"
trap 'rm -f "$tmp_service" "$tmp_timer"' EXIT
cat > "$tmp_service" <<EOF
[Unit]
Description=Sample Price Checker V2 $PRICE_CHECKER_V2_ENV host resources

[Service]
Type=oneshot
User=1000
Group=1000
UMask=0077
NoNewPrivileges=true
ExecStart=/usr/bin/python3 $repo_dir/deployment/v2/host_health.py $PRICE_CHECKER_V2_DATA_DIR/state
EOF
cat > "$tmp_timer" <<EOF
[Unit]
Description=Sample Price Checker V2 $PRICE_CHECKER_V2_ENV host resources every minute

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
systemctl enable --now "$unit.timer"
systemctl start "$unit.service"
echo "Host monitoring installed: $unit.timer"
