#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_PATH="${DEPLOY_PATH:?DEPLOY_PATH is required}"
RETENTION_DAYS="${DOCKER_CLEANUP_RETENTION_DAYS:-7}"
SERVICE_NAME="museum-image-docker-cleanup"
SYSTEMD_DIR="/etc/systemd/system"
SERVICE_FILE="$SYSTEMD_DIR/$SERVICE_NAME.service"
TIMER_FILE="$SYSTEMD_DIR/$SERVICE_NAME.timer"

log() {
  printf '[docker-cleanup-timer] %s\n' "$*"
}

if [ "${INSTALL_DOCKER_CLEANUP_TIMER:-true}" != "true" ]; then
  log "Timer installation is disabled"
  exit 0
fi

if [ "$(id -u)" -ne 0 ] || ! command -v systemctl >/dev/null 2>&1; then
  log "Skipping timer installation: it requires root and systemd"
  exit 0
fi

if ! [[ "$RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]]; then
  printf 'DOCKER_CLEANUP_RETENTION_DAYS must be a positive integer, got: %s\n' "$RETENTION_DAYS" >&2
  exit 2
fi

install -m 0755 "$DEPLOY_PATH/scripts/docker_cleanup.sh" "/usr/local/sbin/$SERVICE_NAME"

cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=Prune old unused Docker images and build cache for Museum Image
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
Environment=DOCKER_CLEANUP_RETENTION_DAYS=$RETENTION_DAYS
ExecStart=/usr/local/sbin/$SERVICE_NAME
EOF

cat >"$TIMER_FILE" <<EOF
[Unit]
Description=Daily Museum Image Docker cleanup check

[Timer]
OnCalendar=*-*-* 04:20:00
RandomizedDelaySec=30m
Persistent=true
Unit=$SERVICE_NAME.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME.timer"
log "Enabled $SERVICE_NAME.timer; unused Docker data older than $RETENTION_DAYS days will be pruned"
