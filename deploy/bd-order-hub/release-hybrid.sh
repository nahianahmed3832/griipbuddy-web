#!/usr/bin/env bash
set -euo pipefail
umask 077

root=/opt/griipbuddy-hybrid-demo
sidecar=/opt/griipbuddy-bd-order-hub
site=/etc/nginx/sites-available/griipbuddy-public-build
base_image=node@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752
mode=${1:?Use prepare or activate}
[[ $(hostname -s) == srv1245833 && $(id -u) == 0 && -L "$root/current" && -s "$sidecar/next.env" ]]

if [[ "$mode" == prepare ]]; then
  archive=${2:?Provide the storefront source archive}
  [[ -s "$archive" ]]
  revision=$(sha256sum "$archive" | cut -c1-20)
  release="$root/releases/$revision"
  if [[ ! -d "$release" ]]; then
    source=$(mktemp -d "$root/.order-hub-unpack.XXXXXXXX")
    tar -xzf "$archive" -C "$source" --no-same-owner --no-same-permissions
    [[ -f "$source/Dockerfile" && -f "$source/deploy/bd-order-hub/next.override.yaml" && ! -e "$source/.env" ]]
    mv -T "$source" "$release"
  fi
  docker build --progress plain --target runtime --build-arg "NODE_IMAGE=$base_image" \
    --build-arg HYBRID_STOREFRONT_BUILD=1 -t "griipbuddy-hybrid-demo:$revision" "$release"
  docker build --progress plain --target operator --build-arg "NODE_IMAGE=$base_image" \
    -t "griipbuddy-hybrid-demo:operator-$revision" "$release"
  printf 'Prepared Hostinger dev candidate %s.\n' "$revision"
  exit
fi

[[ "$mode" == activate ]]
expected=${2:?Provide the expected running staging revision}
revision=${3:?Provide the prepared staging revision}
[[ "$expected" =~ ^[a-f0-9]{20}$ && "$revision" =~ ^[a-f0-9]{20}$ && "$expected" != "$revision" ]]
release="$root/releases/$revision"
previous="$root/releases/$expected"

exec 9>"$root/deploy.lock"
flock -w 90 9
[[ $(readlink -f "$root/current") == "$previous" ]]
[[ $(docker inspect --format '{{.Config.Image}}' griipbuddy-hybrid-demo-app-1) == "griipbuddy-hybrid-demo:$expected" ]]
docker exec griipbuddy-hybrid-demo-app-1 node -e '
  const db = new URL(process.env.DATABASE_URL);
  if (process.env.COMMERCE_MODE !== "staging" || process.env.GRIIP_MARKETPLACE_PREVIEW !== "1" ||
      process.env.SHOPPER_MAIL_MODE !== "preview" || db.hostname !== "db" ||
      db.pathname !== "/griipbuddy_hybrid_demo" || process.env.BETTER_AUTH_URL !== "https://dev.griipbuddy.com") process.exit(1);
'
docker image inspect "griipbuddy-hybrid-demo:$revision" "griipbuddy-hybrid-demo:operator-$revision" >/dev/null
[[ $(docker network inspect --format '{{.Internal}}' griipbuddy-bd-order-hub_bridge) == true ]]
[[ $(docker inspect --format '{{.State.Health.Status}}' griipbuddy-bd-order-hub-api-1) == healthy ]]

candidate=(docker compose --env-file "$root/compose.env" -f "$release/deploy/compose.hybrid-demo.yaml"
  -f "$release/deploy/bd-order-hub/next.override.yaml")
prior=(docker compose --env-file "$root/compose.env" -f "$previous/deploy/compose.hybrid-demo.yaml")
if docker inspect --format '{{ range $name,$network := .NetworkSettings.Networks }}{{println $name}}{{end}}' \
    griipbuddy-hybrid-demo-app-1 | grep -Fxq griipbuddy-bd-order-hub_bridge; then
  prior+=(-f "$previous/deploy/bd-order-hub/next.override.yaml")
fi
if [[ -s "$root/inventory.env" ]]; then
  [[ $(docker network inspect --format '{{.Internal}}' griipbuddy-hybrid-inventory_bridge) == true ]]
  candidate+=(-f "$release/deploy/bd-order-hub/inventory.override.yaml")
  if docker inspect --format '{{ range $name,$network := .NetworkSettings.Networks }}{{println $name}}{{end}}' \
      griipbuddy-hybrid-demo-app-1 | grep -Fxq griipbuddy-hybrid-inventory_bridge; then
    prior+=(-f "$previous/deploy/bd-order-hub/inventory.override.yaml")
  fi
fi
APP_REVISION="$revision" "${candidate[@]}" config --quiet

backup="$root/backups/order-hub-$(date -u +%Y%m%dT%H%M%SZ)-$expected"
install -d -m 0700 "$backup"
cp --preserve=mode,ownership "$site" "$backup/dev-nginx.conf"
docker exec -i griipbuddy-hybrid-demo-db-1 pg_dump -Fc --no-owner -U griipbuddy_demo griipbuddy_hybrid_demo > "$backup/staging.dump"
docker exec -i griipbuddy-hybrid-demo-db-1 pg_restore --list < "$backup/staging.dump" > /dev/null
docker run --rm -i --network griipbuddy-hybrid-demo_database --env-file "$root/app.env" \
  "griipbuddy-hybrid-demo:operator-$revision" npm run db:migrate

nginx_candidate=$(mktemp "$root/.order-hub-nginx.XXXXXXXX")
python3 - "$site" "$nginx_candidate" <<'PY'
from pathlib import Path
import sys

source, target = map(Path, sys.argv[1:])
config = source.read_text()
marker = 'map "$request_method:$uri" $griipbuddy_public_method_denied {\n'
allowance = '    ~^POST:/api/marketplace/bd-orders$ 0;\n'
assert config.count(marker) == 1
assert config.count('server_name dev.griipbuddy.com;') == 2
assert config.count('if ($griipbuddy_public_method_denied) { return 405; }') == 1
if allowance not in config:
    config = config.replace(marker, marker + allowance, 1)
target.write_text(config)
PY

app_attempted=0
nginx_attempted=0
rollback() {
  local status=$?
  trap - ERR
  if (( nginx_attempted )); then
    cp --preserve=mode,ownership "$backup/dev-nginx.conf" "$site"
    nginx -t && systemctl reload nginx || true
  fi
  if (( app_attempted )); then
    APP_REVISION="$expected" "${prior[@]}" up -d --no-deps --no-build --pull never --wait --wait-timeout 80 app || true
  fi
  exit "$status"
}
trap rollback ERR
app_attempted=1
APP_REVISION="$revision" "${candidate[@]}" up -d --no-deps --no-build --pull never --wait --wait-timeout 90 app
docker exec griipbuddy-hybrid-demo-app-1 node -e '
  const origin = process.env.BD_ORDER_HUB_BRIDGE_URL;
  if (origin !== "http://bd-order-hub-api:38100") process.exit(1);
  fetch(origin + "/health", { signal: AbortSignal.timeout(5000) }).then(r => process.exit(r.status === 204 ? 0 : 1)).catch(() => process.exit(1));
'
origin=https://dev.griipbuddy.com
direct_status=$(curl --silent --show-error --max-time 10 -H "Origin: $origin" -H 'Content-Type: application/json' \
  --data '{}' -o /dev/null -w '%{http_code}' http://127.0.0.1:4402/api/marketplace/bd-orders)
if [[ "$direct_status" != 401 ]]; then
  printf 'Direct staging order recovery returned HTTP %s instead of 401.\n' "$direct_status" >&2
  false
fi

if ! cmp -s "$nginx_candidate" "$site"; then
  nginx_attempted=1
  install -m 0644 "$nginx_candidate" "$site"
  nginx -t
  systemctl reload nginx
fi
rm -f "$nginx_candidate"
dev=(curl --silent --show-error --max-time 5 --resolve dev.griipbuddy.com:443:127.0.0.1)
api_status=000
for attempt in {1..10}; do
  health=$("${dev[@]}" -f "$origin/api/health") || health=""
  if [[ "$health" == *"\"revision\":\"$revision\""* && "$health" == *'"orderIntake":"test-only"'* ]] &&
     "${dev[@]}" -f "$origin/bd/orders" > /dev/null; then
    api_status=$("${dev[@]}" -H "Origin: $origin" -H 'Content-Type: application/json' \
      --data '{}' -o /dev/null -w '%{http_code}' "$origin/api/marketplace/bd-orders") || api_status=000
    if [[ "$api_status" == 401 ]]; then break; fi
  fi
  sleep 1
done
if [[ "$api_status" != 401 ]]; then
  printf 'Dev ingress recovery smoke did not pass. Last HTTP status %s.\n' "$api_status" >&2
  false
fi
ln -s "$release" "$root/.current.$revision"
mv -Tf "$root/.current.$revision" "$root/current"
trap - ERR
printf 'Activated Hostinger dev order hub %s.\n' "$revision"
