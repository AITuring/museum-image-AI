#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_PATH="${DEPLOY_PATH:?DEPLOY_PATH is required}"
REPO_URL="${REPO_URL:?REPO_URL is required}"
BRANCH="${BRANCH:-main}"
DEPLOY_REF="${DEPLOY_REF:-}"
BACKEND_IMAGE="${BACKEND_IMAGE:?BACKEND_IMAGE is required}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.cloud.yml}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:8000/api/health}"
HEALTHCHECK_RETRIES="${HEALTHCHECK_RETRIES:-30}"
HEALTHCHECK_INTERVAL="${HEALTHCHECK_INTERVAL:-5}"
GHCR_USERNAME="${GHCR_USERNAME:-}"
GHCR_TOKEN="${GHCR_TOKEN:-}"

DEPLOY_STATE_DIR="$DEPLOY_PATH/.deploy"
CURRENT_RELEASE_FILE="$DEPLOY_STATE_DIR/current_release.env"
HISTORY_FILE="$DEPLOY_STATE_DIR/release_history.tsv"
TEMP_DIR=""

log() {
  printf '[deploy] %s\n' "$*"
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
    mkdir -p "$(dirname "$DEPLOY_PATH")"
    log "Cloning repository into $DEPLOY_PATH"
    git clone "$REPO_URL" "$DEPLOY_PATH"
  fi

  cd "$DEPLOY_PATH"
  mkdir -p "$DEPLOY_STATE_DIR"
  git remote set-url origin "$REPO_URL"

  if [ ! -f "$DEPLOY_PATH/.env" ]; then
    printf 'Missing %s/.env. Create it from .env.example before deployment.\n' "$DEPLOY_PATH" >&2
    exit 1
  fi
}

resolve_deploy_ref() {
  if [ -n "$DEPLOY_REF" ]; then
    printf '%s\n' "$DEPLOY_REF"
    return
  fi

  case "$BACKEND_IMAGE" in
    *:sha-*)
      printf '%s\n' "${BACKEND_IMAGE##*:sha-}"
      ;;
    *)
      printf '%s\n' "origin/$BRANCH"
      ;;
  esac
}

checkout_ref() {
  local requested_ref="$1"

  log "Fetching repository metadata from $BRANCH"
  git fetch --prune origin "$BRANCH" --tags
  log "Checking out $requested_ref"
  git checkout --force "$requested_ref"
}

write_release_state() {
  local release_commit="$1"
  local image="$2"

  cat >"$CURRENT_RELEASE_FILE" <<EOF
RELEASE_COMMIT=$release_commit
RELEASE_IMAGE=$image
EOF

  printf '%s\t%s\t%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$release_commit" "$image" >>"$HISTORY_FILE"
}

load_release_state() {
  local release_file="$1"

  if [ ! -f "$release_file" ]; then
    return 1
  fi

  # shellcheck disable=SC1090
  source "$release_file"
}

deploy_release() {
  local release_commit="$1"
  local image="$2"

  export BACKEND_IMAGE="$image"

  log "Pulling backend image $image"
  docker compose -f "$COMPOSE_FILE" pull backend
  log "Starting services with $COMPOSE_FILE"
  docker compose -f "$COMPOSE_FILE" up -d
  wait_for_healthcheck

  write_release_state "$release_commit" "$image"
}

main() {
  require_command git
  require_command docker
  require_command curl

  setup_git_ssh
  ensure_repo
  login_ghcr

  local previous_commit=""
  local previous_image=""
  local rollback_ref=""
  local target_ref=""
  local target_commit=""

  if load_release_state "$CURRENT_RELEASE_FILE"; then
    previous_commit="${RELEASE_COMMIT:-}"
    previous_image="${RELEASE_IMAGE:-}"
  fi

  target_ref="$(resolve_deploy_ref)"
  checkout_ref "$target_ref"
  target_commit="$(git rev-parse --verify HEAD)"

  if deploy_release "$target_commit" "$BACKEND_IMAGE"; then
    log "Deployment succeeded for $target_commit"
    return 0
  fi

  log "Deployment failed"

  if [ -z "$previous_commit" ] || [ -z "$previous_image" ]; then
    log "No previous successful release recorded, cannot roll back automatically"
    exit 1
  fi

  rollback_ref="$previous_commit"
  checkout_ref "$rollback_ref"

  if deploy_release "$previous_commit" "$previous_image"; then
    log "Rollback succeeded, current release restored"
  else
    log "Automatic rollback failed"
  fi

  exit 1
}

main "$@"
