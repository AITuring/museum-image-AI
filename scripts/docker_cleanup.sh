#!/usr/bin/env bash
set -Eeuo pipefail

# Keep a few recent release images available for rollback while preventing a
# small cloud disk from filling with every CI-built backend image. Docker will
# never remove an image referenced by any container, including a stopped one.
RETENTION_DAYS="${DOCKER_CLEANUP_RETENTION_DAYS:-7}"
RETENTION_HOURS="${DOCKER_CLEANUP_RETENTION_HOURS:-}"

if [ -z "$RETENTION_HOURS" ]; then
  if ! [[ "$RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]]; then
    printf 'DOCKER_CLEANUP_RETENTION_DAYS must be a positive integer, got: %s\n' "$RETENTION_DAYS" >&2
    exit 2
  fi
  RETENTION_HOURS=$((RETENTION_DAYS * 24))
fi

if ! [[ "$RETENTION_HOURS" =~ ^[1-9][0-9]*$ ]]; then
  printf 'DOCKER_CLEANUP_RETENTION_HOURS must be a positive integer, got: %s\n' "$RETENTION_HOURS" >&2
  exit 2
fi

command -v docker >/dev/null 2>&1 || {
  printf 'docker command is unavailable\n' >&2
  exit 1
}

printf '[docker-cleanup] retaining the last %s hours of unused Docker data\n' "$RETENTION_HOURS"
docker image prune --all --force --filter "until=${RETENTION_HOURS}h"
docker builder prune --all --force --filter "until=${RETENTION_HOURS}h"
printf '[docker-cleanup] completed at %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
