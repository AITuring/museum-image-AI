#!/usr/bin/env bash
set -Eeuo pipefail

# Configure the public API hostname without touching the existing Vercel frontend.
# The script is intentionally conservative: it refuses to overwrite an unmanaged
# Caddyfile and only appends the preview origin to the backend CORS setting.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_PATH="${DEPLOY_PATH:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
DEPLOY_PATH="$(cd -- "$DEPLOY_PATH" && pwd)"

API_DOMAIN="${API_DOMAIN:-api.aituring.xyz}"
EXPECTED_DNS_IP="${EXPECTED_DNS_IP:-123.57.34.90}"
UPSTREAM="${UPSTREAM:-127.0.0.1:8000}"
FRONTEND_ORIGIN="${FRONTEND_ORIGIN:-https://image.aituring.xyz}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
BACKEND_ENV_FILE="${BACKEND_ENV_FILE:-$DEPLOY_PATH/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$DEPLOY_PATH/docker-compose.cloud.yml}"
INSTALL_CADDY=false
RESTART_BACKEND=false
SKIP_CORS=false
TEMP_CONFIG=""
CORS_TEMP=""
CORS_HEADERS=""

log() {
  printf '[api-https] %s\n' "$*"
}

cleanup() {
  if [ -n "$TEMP_CONFIG" ]; then
    rm -f -- "$TEMP_CONFIG"
  fi
  if [ -n "$CORS_TEMP" ]; then
    rm -f -- "$CORS_TEMP"
  fi
  if [ -n "$CORS_HEADERS" ]; then
    rm -f -- "$CORS_HEADERS"
  fi
}

trap cleanup EXIT

die() {
  printf '[api-https] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: configure_api_https.sh [options]

Configure Caddy HTTPS for api.aituring.xyz and add the Vercel origin to the
cloud backend CORS setting. Run as root on the cloud server.

Options:
  --install-caddy       Install Caddy from its official Debian/Ubuntu package
  --restart-backend     Recreate the cloud backend so the CORS change is loaded
  --skip-cors           Do not read or modify the backend .env file
  --domain HOST         API hostname (default: api.aituring.xyz)
  --expected-ip IP      DNS A-record value (default: 123.57.34.90)
  --upstream HOST:PORT  Local backend upstream (default: 127.0.0.1:8000)
  --frontend-origin URL CORS origin (default: https://image.aituring.xyz)
  --env-file PATH       Cloud backend .env (default: DEPLOY_PATH/.env)
  --compose-file PATH   Cloud compose file (default: DEPLOY_PATH/docker-compose.cloud.yml)
  --caddyfile PATH      Caddyfile (default: /etc/caddy/Caddyfile)
  -h, --help            Show this help
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --install-caddy)
      INSTALL_CADDY=true
      ;;
    --restart-backend)
      RESTART_BACKEND=true
      ;;
    --skip-cors)
      SKIP_CORS=true
      ;;
    --domain)
      shift
      API_DOMAIN="${1:?--domain requires a value}"
      ;;
    --expected-ip)
      shift
      EXPECTED_DNS_IP="${1:?--expected-ip requires a value}"
      ;;
    --upstream)
      shift
      UPSTREAM="${1:?--upstream requires a value}"
      ;;
    --frontend-origin)
      shift
      FRONTEND_ORIGIN="${1:?--frontend-origin requires a value}"
      ;;
    --env-file)
      shift
      BACKEND_ENV_FILE="${1:?--env-file requires a value}"
      ;;
    --compose-file)
      shift
      COMPOSE_FILE="${1:?--compose-file requires a value}"
      ;;
    --caddyfile)
      shift
      CADDYFILE="${1:?--caddyfile requires a value}"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
  shift
done

if [ "$(id -u)" -ne 0 ]; then
  die "run as root, for example: sudo $0 --install-caddy --restart-backend"
fi

if [[ ! "$API_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || [[ "$API_DOMAIN" == .* ]] || [[ "$API_DOMAIN" == *. ]]; then
  die "invalid API domain: $API_DOMAIN"
fi
if [[ ! "$EXPECTED_DNS_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  die "expected DNS value must be an IPv4 address: $EXPECTED_DNS_IP"
fi
if [[ ! "$UPSTREAM" =~ ^[A-Za-z0-9_.:-]+$ ]]; then
  die "invalid upstream: $UPSTREAM"
fi
if [[ ! "$FRONTEND_ORIGIN" =~ ^https://[A-Za-z0-9.-]+$ ]]; then
  die "frontend origin must be an HTTPS origin without a path: $FRONTEND_ORIGIN"
fi

MARKER_BEGIN="# BEGIN museum-image-api managed site: $API_DOMAIN"
MARKER_END="# END museum-image-api managed site: $API_DOMAIN"

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

require_command awk
require_command curl
require_command getent
require_command grep
require_command install
require_command sort
require_command systemctl

resolve_dns() {
  local resolved_ips
  resolved_ips="$(getent ahostsv4 "$API_DOMAIN" | awk '{print $1}' | sort -u)"
  if [ -z "$resolved_ips" ]; then
    die "$API_DOMAIN has no IPv4 DNS answer"
  fi
  if ! grep -Fqx "$EXPECTED_DNS_IP" <<<"$resolved_ips"; then
    die "$API_DOMAIN does not resolve to $EXPECTED_DNS_IP; got: $(tr '\n' ' ' <<<"$resolved_ips")"
  fi
  log "DNS $API_DOMAIN -> $EXPECTED_DNS_IP"
}

install_caddy() {
  if command -v caddy >/dev/null 2>&1; then
    return
  fi
  if [ "$INSTALL_CADDY" != true ]; then
    die "Caddy is not installed; rerun with --install-caddy"
  fi
  require_command apt-get

  log "Installing Caddy from the official Debian/Ubuntu repository"
  apt-get update
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  require_command gpg
  install -d -m 0755 /usr/share/keyrings
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    -o /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  chmod o+r /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
}

has_non_comment_content() {
  awk '!/^[[:space:]]*(#|$)/ { found = 1 } END { exit found ? 0 : 1 }' "$1"
}

write_caddyfile() {
  local caddy_dir backup_path
  caddy_dir="$(dirname -- "$CADDYFILE")"
  TEMP_CONFIG="$(mktemp "${TMPDIR:-/tmp}/museum-api-caddy.XXXXXX")"

  install -d -m 0755 "$caddy_dir"

  if [ -f "$CADDYFILE" ]; then
    if grep -Fqx "$MARKER_BEGIN" "$CADDYFILE"; then
      if ! awk -v begin="$MARKER_BEGIN" -v end="$MARKER_END" '
        $0 == begin { inside = 1; next }
        inside && $0 == end { inside = 0; next }
        !inside { print }
        END { if (inside) exit 42 }
      ' "$CADDYFILE" >"$TEMP_CONFIG"; then
        die "managed Caddy block is incomplete in $CADDYFILE"
      fi
    elif has_non_comment_content "$CADDYFILE"; then
      die "$CADDYFILE contains an unmanaged site; add the API block manually or use a separate --caddyfile"
    else
      cp -- "$CADDYFILE" "$TEMP_CONFIG"
    fi
  fi

  if [ -s "$TEMP_CONFIG" ]; then
    printf '\n' >>"$TEMP_CONFIG"
  fi
  cat >>"$TEMP_CONFIG" <<EOF
$MARKER_BEGIN
$API_DOMAIN {
    reverse_proxy $UPSTREAM
}
$MARKER_END
EOF

  caddy fmt --overwrite "$TEMP_CONFIG" >/dev/null
  caddy validate --config "$TEMP_CONFIG" --adapter caddyfile

  if [ -f "$CADDYFILE" ]; then
    backup_path="$CADDYFILE.bak.$(date -u +%Y%m%dT%H%M%SZ)"
    cp -a -- "$CADDYFILE" "$backup_path"
    log "Backed up existing Caddyfile to $backup_path"
  fi
  install -o root -g root -m 0644 "$TEMP_CONFIG" "$CADDYFILE"
  log "Wrote $CADDYFILE"
}

update_cors() {
  [ "$SKIP_CORS" = true ] && return
  [ -f "$BACKEND_ENV_FILE" ] || die "backend env file not found: $BACKEND_ENV_FILE"
  require_command python3

  CORS_TEMP="$(mktemp "${BACKEND_ENV_FILE}.tmp.XXXXXX")"
  python3 - "$BACKEND_ENV_FILE" "$FRONTEND_ORIGIN" "$CORS_TEMP" <<'PY'
import os
import stat
import sys
from pathlib import Path

env_path = Path(sys.argv[1])
origin = sys.argv[2]
temp_path = Path(sys.argv[3])
lines = env_path.read_text(encoding="utf-8").splitlines(keepends=True)
updated = False
output = []

for line in lines:
    if not updated and line.startswith("CORS_ORIGINS="):
        raw_value = line.split("=", 1)[1].rstrip("\r\n")
        newline = line[len(line.rstrip("\r\n")) :]
        quote = raw_value[0] if len(raw_value) >= 2 and raw_value[0] == raw_value[-1] and raw_value[0] in "'\"" else ""
        value = raw_value[1:-1] if quote else raw_value
        origins = [item.strip() for item in value.split(",") if item.strip()]
        if origin not in origins:
            origins.append(origin)
        output.append(f"CORS_ORIGINS={quote}{','.join(origins)}{quote}{newline or os.linesep}")
        updated = True
    else:
        output.append(line)

if not updated:
    if output and not output[-1].endswith(("\n", "\r")):
        output.append(os.linesep)
    output.append(f"CORS_ORIGINS={origin}{os.linesep}")

mode = stat.S_IMODE(env_path.stat().st_mode)
temp_path.write_text("".join(output), encoding="utf-8")
os.chmod(temp_path, mode)
os.replace(temp_path, env_path)
PY
  log "Ensured CORS_ORIGINS contains $FRONTEND_ORIGIN in $BACKEND_ENV_FILE"
}

restart_backend() {
  [ "$RESTART_BACKEND" = true ] || return
  [ -f "$COMPOSE_FILE" ] || die "cloud compose file not found: $COMPOSE_FILE"
  require_command docker
  log "Recreating the cloud backend to load CORS_ORIGINS"
  (cd -- "$DEPLOY_PATH" && docker compose -f "$COMPOSE_FILE" up -d --no-deps backend)
}

verify_cors() {
  [ "$SKIP_CORS" = true ] && return
  [ "$RESTART_BACKEND" = true ] || return

  CORS_HEADERS="$(mktemp "${TMPDIR:-/tmp}/museum-api-cors.XXXXXX")"
  if ! curl --fail --silent --show-error --max-time 15 \
    -D "$CORS_HEADERS" -o /dev/null \
    -H "Origin: $FRONTEND_ORIGIN" \
    "http://127.0.0.1:8000/api/health"; then
    die "backend health check failed while validating CORS"
  fi
  if ! grep -Fiq "access-control-allow-origin: $FRONTEND_ORIGIN" "$CORS_HEADERS"; then
    die "backend did not return Access-Control-Allow-Origin for $FRONTEND_ORIGIN"
  fi
  log "CORS check passed for $FRONTEND_ORIGIN"
}

verify_caddy() {
  if systemctl is-active --quiet caddy; then
    systemctl reload caddy
  else
    systemctl enable --now caddy
  fi

  local health_url="https://$API_DOMAIN/api/health"
  if ! curl --fail --silent --show-error --max-time 20 \
    --resolve "$API_DOMAIN:443:127.0.0.1" "$health_url" >/dev/null; then
    die "Caddy is running but HTTPS health check failed; check ports 80/443 and journalctl -u caddy"
  fi
  log "HTTPS health check passed: $health_url"
}

resolve_dns
install_caddy
write_caddyfile
update_cors
restart_backend
verify_cors
verify_caddy

if [ "$SKIP_CORS" = false ] && [ "$RESTART_BACKEND" = false ]; then
  log "CORS was written but the backend was not restarted; rerun with --restart-backend"
fi
log "API HTTPS configuration complete; CLOUD_API_BASE_URL remains http://123.57.34.90:8000"
