#!/usr/bin/env bash
set -euo pipefail
umask 077

edge_options=(-sS --max-time 12)
case "${1:-}" in
  '') ;;
  --edge-loopback) edge_options+=(--resolve dev.griipbuddy.com:443:127.0.0.1) ;;
  *) printf 'Usage: bash deploy/check-marketplace-edge.sh [--edge-loopback]\n' >&2; exit 2 ;;
esac

origin=https://dev.griipbuddy.com
body=$(mktemp)
headers=$(mktemp)
trap 'rm -f -- "$body" "$headers"' EXIT

request() {
  local method=$1 path=$2 expected=$3 marker=${4:-} status
  local args=(-X "$method")
  if [[ "$method" == POST ]]; then
    args+=(--json '{}' -H "Origin: $origin")
  fi
  status=$(curl "${edge_options[@]}" "${args[@]}" \
    -D "$headers" -o "$body" -w '%{http_code}' "$origin$path")
  if [[ ! " $expected " == *" $status "* ]] || { [[ -n "$marker" ]] && ! grep -Fq "$marker" "$body"; }; then
    printf '%s %s got %s, expected %s with the configured route response.\n' "$method" "$path" "$status" "$expected" >&2
    return 1
  fi
  printf '%s %s %s\n' "$method" "$path" "$status"
}

# No credentials and no valid mutation bodies are sent by these checks.
request GET /marketplace/api/health 200 '"database":"ok"'
grep -Eiq '^cache-control:[[:space:]]*private,.*no-store' "$headers"
grep -Eiq '^x-robots-tag:[[:space:]]*noindex' "$headers"
request POST /marketplace/api/measurement '400 404' '"choice":'
request POST /marketplace/api/recommendations 400 '"rows":'
request POST /marketplace/api/recommendation-preferences 400 '"choice":'
request POST /marketplace/api/staff/intelligence/analyst 401 'Staff sign-in is required.'
request POST /marketplace/api/staff/workflows/agent 404 'Agent proposal access unavailable.'
request POST /marketplace/api/staff/catalog 401
request POST /marketplace/api/staff/catalog/context 401
request POST /marketplace/api/marketplace/seller/catalog '401 404'
request POST /marketplace/api/checkout/prepaid '400 404 422' '"kind":'
request POST /marketplace/api/checkout/prepaid/callback '400 404'
request POST /marketplace/api/dev-route-check 405
request GET /marketplace/api/internal/dev-route-check 404
request GET /marketplace/api/internal/main-admin-catalog 404
request POST /marketplace/api/internal/main-admin-catalog '404 405'
request GET /api/internal/dev-route-check 404
request GET /api/v1/country/all 404
