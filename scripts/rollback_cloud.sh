#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_PATH="${DEPLOY_PATH:?DEPLOY_PATH is required}"
REPO_URL="${REPO_URL:?REPO_URL is required}"
BRANCH="${BRANCH:-main}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.cloud.yml}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:8000/api/health}"
HEALTHCHECK_RETRIES="${HEALTHCHECK_RETRIES:-30}"
HEALTHCHECK_INTERVAL="${HEALTHCHECK_INTERVAL:-5}"
ROLLBACK_TARGET="${ROLLBACK_TARGET:-previous-successful}"
ROLLBACK_REF="${ROLLBACK_REF:-}"
ROLLBACK_IMAGE="${ROLLBACK_IMAGE:-}"
GHCR_USERNAME="${GHCR_USERNAME:-}"
GHCR_TOKEN="${GHCR_TOKEN:-}"
REPO_SSH_PRIVATE_KEY_B64="${REPO_SSH_PRIVATE_KEY_B64:-}"
DEPLOY_EXHIBITION_SYNC_WORKER="${DEPLOY_EXHIBITION_SYNC_WORKER:-false}"

DEPLOY_STATE_DIR="$DEPLOY_PATH/.deploy"
CURRENT_RELEASE_FILE="$DEPLOY_STATE_DIR/current_release.env"
HISTORY_FILE="$DEPLOY_STATE_DIR/release_history.tsv"
TEMP_DIR=""

log() {
  printf '[rollback] %s\n' "$*"
}

cleanup() {
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
  fi
}

trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  }
}

setup_git_ssh() {
  if [ -z "${REPO_SSH_PRIVATE_KEY:-}" ] && [ -n "$REPO_SSH_PRIVATE_KEY_B64" ]; then
    REPO_SSH_PRIVATE_KEY="$(printf '%s' "$REPO_SSH_PRIVATE_KEY_B64" | base64 --decode)"
  fi

  if [ -z "${REPO_SSH_PRIVATE_KEY:-}" ]; then
    return
  fi

  require_command ssh-keyscan

  TEMP_DIR="$(mktemp -d)"
  local key_file="$TEMP_DIR/repo_deploy_key"
  local known_hosts_file="$TEMP_DIR/known_hosts"

  printf '%s\n' "$REPO_SSH_PRIVATE_KEY" >"$key_file"
  chmod 600 "$key_file"
  ssh-keyscan github.com >"$known_hosts_file" 2>/dev/null

  export GIT_SSH_COMMAND="ssh -i $key_file -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$known_hosts_file"
}

login_ghcr() {
  if [ -z "$GHCR_USERNAME" ] || [ -z "$GHCR_TOKEN" ]; then
    log "Skipping GHCR login because credentials were not provided"
    return
  fi

  printf '%s\n' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin >/dev/null
}

wait_for_healthcheck() {
  local attempt

  for attempt in $(seq 1 "$HEALTHCHECK_RETRIES"); do
    if curl -fsS "$HEALTHCHECK_URL" >/dev/null; then
      log "Healthcheck passed: $HEALTHCHECK_URL"
      return 0
    fi

    log "Healthcheck not ready ($attempt/$HEALTHCHECK_RETRIES)"
    sleep "$HEALTHCHECK_INTERVAL"
  done

  return 1
}

ensure_repo() {
  if [ ! -d "$DEPLOY_PATH/.git" ]; then
    printf 'Repository does not exist at %s\n' "$DEPLOY_PATH" >&2
    exit 1
  fi

  cd "$DEPLOY_PATH"
  mkdir -p "$DEPLOY_STATE_DIR"
  git remote set-url origin "$REPO_URL"
  git fetch --prune origin "$BRANCH" --tags

  if [ ! -f "$DEPLOY_PATH/.env" ]; then
    printf 'Missing %s/.env. Create it from .env.example before rollback.\n' "$DEPLOY_PATH" >&2
    exit 1
  fi
}

load_current_release() {
  if [ ! -f "$CURRENT_RELEASE_FILE" ]; then
    return 1
  fi

  # shellcheck disable=SC1090
  source "$CURRENT_RELEASE_FILE"
}

resolve_release_from_history() {
  local line=""

  if [ ! -f "$HISTORY_FILE" ]; then
    return 1
  fi

  case "$ROLLBACK_TARGET" in
    previous-successful)
      line="$(tail -n 2 "$HISTORY_FILE" | head -n 1)"
      ;;
    last-successful)
      line="$(tail -n 1 "$HISTORY_FILE")"
      ;;
    custom)
      if [ -z "$ROLLBACK_REF" ] || [ -z "$ROLLBACK_IMAGE" ]; then
        printf 'ROLLBACK_REF and ROLLBACK_IMAGE are required when ROLLBACK_TARGET=custom\n' >&2
        exit 1
      fi
      printf '%s\t%s\t%s\n' "manual" "$ROLLBACK_REF" "$ROLLBACK_IMAGE"
      return 0
      ;;
    *)
      printf 'Unsupported ROLLBACK_TARGET: %s\n' "$ROLLBACK_TARGET" >&2
      exit 1
      ;;
  esac

  if [ -z "$line" ]; then
    return 1
  fi

  printf '%s\n' "$line"
}

checkout_ref() {
  local target_ref="$1"

  log "Checking out $target_ref"
  git checkout --force "$target_ref"
}

deploy_release() {
  local release_commit="$1"
  local image="$2"

  export BACKEND_IMAGE="$image"
  log "Stopping exhibition sync worker before rollback"
  docker compose -f "$COMPOSE_FILE" stop exhibition-sync-worker || true
  docker compose -f "$COMPOSE_FILE" pull backend
  docker compose -f "$COMPOSE_FILE" up -d --wait postgres exhibitions-postgres
  docker compose -f "$COMPOSE_FILE" up -d --no-deps backend
  wait_for_healthcheck

  if [ "$DEPLOY_EXHIBITION_SYNC_WORKER" = "true" ]; then
    log "Starting opt-in exhibition sync worker"
    docker compose -f "$COMPOSE_FILE" --profile exhibition-sync up -d --no-deps exhibition-sync-worker
  else
    log "Exhibition sync worker remains stopped"
  fi

  cat >"$CURRENT_RELEASE_FILE" <<EOF
RELEASE_COMMIT=$release_commit
RELEASE_IMAGE=$image
EOF

  printf '%s\t%s\t%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$release_commit" "$image" >>"$HISTORY_FILE"
}

main() {
  require_command git
  require_command docker
  require_command curl

  setup_git_ssh
  ensure_repo
  login_ghcr

  local release_line=""
  local ignored_timestamp=""
  local target_ref=""
  local target_image=""
  local target_commit=""

  if [ "$ROLLBACK_TARGET" = "last-successful" ] && load_current_release; then
    target_ref="${RELEASE_COMMIT:-}"
    target_image="${RELEASE_IMAGE:-}"
  else
    release_line="$(resolve_release_from_history)" || {
      printf 'Unable to resolve rollback target from history\n' >&2
      exit 1
    }
    IFS=$'\t' read -r ignored_timestamp target_ref target_image <<<"$release_line"
  fi

  if [ -z "$target_ref" ] || [ -z "$target_image" ]; then
    printf 'Resolved rollback target is incomplete\n' >&2
    exit 1
  fi

  checkout_ref "$target_ref"
  target_commit="$(git rev-parse --verify HEAD)"
  log "Rolling back to $target_commit with image $target_image"
  deploy_release "$target_commit" "$target_image"
  log "Rollback completed"
}

main "$@"
