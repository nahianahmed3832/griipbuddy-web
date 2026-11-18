#!/usr/bin/env bash
set -euo pipefail
umask 077

root=/opt/griipbuddy-bd-order-hub
bundle=${1:?Provide the prepared Bangladesh order hub sidecar tar.gz}
[[ $(hostname -s) == srv1245833 && $(id -u) == 0 && -s "$bundle" ]]
install -d -m 0700 "$root" "$root/releases"
exec 9>"$root/install.lock"
flock -n 9

revision=$(sha256sum "$bundle" | cut -c1-20)
release="$root/releases/$revision"
previous=""
if [[ -L "$root/current" ]]; then previous=$(readlink -f "$root/current"); fi
if [[ ! -d "$release" ]]; then
  candidate=$(mktemp -d "$root/.unpack.XXXXXXXX")
  tar --no-same-owner --no-same-permissions -xzf "$bundle" -C "$candidate"
  [[ -f "$candidate/compose.yaml" && -f "$candidate/mongo-init.js" ]]
  [[ -f "$candidate/source/recovery/hostinger/customer-orders-server.mjs" ]]
  [[ -f "$candidate/source/recovery/hostinger/customer-orders-fixture.cjs" ]]
  [[ -f "$candidate/source/src/app/modules/customer-orders/routes.js" ]]
  find "$candidate/source" -type d -exec chmod 0555 {} +
  find "$candidate/source" -type f -exec chmod 0444 {} +
  chmod 0444 "$candidate/mongo-init.js"
  mv "$candidate" "$release"
fi

env_file="$root/sidecar.env"
if [[ ! -s "$env_file" ]]; then
  [[ -z "$previous" ]]
  {
    for key in BD_ORDER_HUB_MONGO_ADMIN_PASSWORD BD_ORDER_HUB_MONGO_READ_PASSWORD BD_ORDER_HUB_MONGO_SEED_PASSWORD \
      BD_ORDER_HUB_BRIDGE_TOKEN BD_ORDER_HUB_FIXTURE_HASH_SECRET BD_ORDER_HUB_LEGACY_SAMPLE_PASSWORD; do
      printf '%s=%s\n' "$key" "$(openssl rand -hex 32)"
    done
  } > "$env_file"
fi

compose() {
  local directory=$1
  shift
  docker compose --env-file "$env_file" -f "$directory/compose.yaml" "$@"
}

rollback() {
  local status=$?
  trap - ERR
  if [[ -n "$previous" && "$previous" != "$release" ]]; then
    compose "$previous" up -d --no-build --pull never --wait --wait-timeout 80 mongo api || true
  elif [[ -z "$previous" ]]; then
    compose "$release" stop api mongo || true
  fi
  exit "$status"
}

compose "$release" config --quiet
trap rollback ERR
compose "$release" up -d --no-build --pull never --wait --wait-timeout 90 mongo api
compose "$release" --profile seed run --rm --no-deps seed
token=$(sed -n 's/^BD_ORDER_HUB_BRIDGE_TOKEN=//p' "$env_file")
[[ "$token" =~ ^[a-f0-9]{64}$ ]]
{
  printf '%s\n' 'BD_ORDER_HUB_MODE=isolated' 'BD_ORDER_HUB_BRIDGE_URL=http://bd-order-hub-api:38100'
  printf 'BD_ORDER_HUB_BRIDGE_TOKEN=%s\n' "$token"
} > "$root/next.env.tmp"
mv -f "$root/next.env.tmp" "$root/next.env"
ln -s "$release" "$root/.current.$revision"
mv -Tf "$root/.current.$revision" "$root/current"
trap - ERR

printf 'Isolated Bangladesh order hub sidecar %s ready.\n' "$revision"
