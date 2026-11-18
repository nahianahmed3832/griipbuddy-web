#!/usr/bin/env bash
set -euo pipefail
umask 077

marketplace_root=/opt/griipbuddy-marketplace-dev
nginx_site=/etc/nginx/sites-available/griipbuddy-public-build
operator=griipbuddy-storefront-stage-operator:35b731525ce5c72682f32e4a5fdb4a4ded52d496
db=griipbuddy_marketplace_dev
db_user=griipbuddy_marketplace
marketplace_methods='    ~^POST:/marketplace/(api/(cart/resolve|checkout(/paypal(/webhook)?)?|marketplace(/(region|listing-photo|listing-video|cases|seller/fulfillment))?|shopper-auth/(sign-in/email|sign-up/email|sign-out|update-user|change-password)|staff/(sign-in|sign-out|catalog-image|catalog-video|catalog-import|merchandising))|staff(/[a-z0-9/-]+)?)$ 0;'
base_image=node@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752
archive=${1:?Provide the marketplace source archive}
catalog=${2:-}

[[ $(id -u) == 0 && -s "$archive" && -f "$nginx_site" ]]
install -d -m 0700 "$marketplace_root" "$marketplace_root/releases" "$marketplace_root/backups"
exec 9>"$marketplace_root/deploy.lock"
flock -n 9
full_sha=$(sha256sum "$archive" | cut -d ' ' -f 1)
rev=${full_sha:0:20}
release="$marketplace_root/releases/$rev"
previous=""
if [[ -L "$marketplace_root/current" ]]; then previous=$(readlink -f "$marketplace_root/current"); fi
if [[ -n "$previous" && "$previous" == "$release" ]]; then
  printf 'Revision %s is already active.\n' "$rev"
  exit 0
fi
if ! [[ -d "$release" ]]; then
  unpack=$(mktemp -d "$marketplace_root/.unpack.XXXXXXXX")
  tar --extract --gzip --file "$archive" --directory "$unpack" --no-same-owner --no-same-permissions
  mv "$unpack" "$release"
fi
[[ -f "$release/Dockerfile" && -f "$release/deploy/compose.marketplace.yaml" && ! -e "$release/.env" ]]

if ! docker image inspect "griipbuddy-marketplace-dev:$rev" >/dev/null 2>&1; then
  docker build --progress plain --target runtime --build-arg "NODE_IMAGE=$base_image" \
    --build-arg NEXT_PUBLIC_STOREFRONT_BASE_PATH=/marketplace --tag "griipbuddy-marketplace-dev:$rev" "$release"
fi
if [[ "${MARKETPLACE_BUILD_ONLY:-0}" == 1 ]]; then
  printf 'Built marketplace candidate %s.\n' "$rev"
  exit 0
fi
docker image inspect "$operator" >/dev/null
if [[ ! -e "$marketplace_root/compose.env" && ! -e "$marketplace_root/app.env" ]]; then
  [[ -z "$previous" && -s "$catalog" ]]
  printf 'MARKETPLACE_ADMIN_PASSWORD=%s\nMARKETPLACE_DB_PASSWORD=%s\n' \
    "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > "$marketplace_root/compose.env"
  # shellcheck disable=SC1091
  source "$marketplace_root/compose.env"
  {
    printf '%s\n' 'COMMERCE_MODE=staging' 'GRIIP_MARKETPLACE_PREVIEW=1' 'MARKETPLACE_TEST_INTAKE_OPEN=1' \
      'ACQUISITION_MEASUREMENT=0' 'BD_CHECKOUT_HANDOFF=0' 'TRUSTED_CLIENT_IP_HEADER=x-forwarded-for' \
      'BETTER_AUTH_URL=https://dev.griipbuddy.com'
    printf 'DATABASE_URL=postgresql://%s:%s@db:5432/%s\n' "$db_user" "$MARKETPLACE_DB_PASSWORD" "$db"
    for key in BETTER_AUTH_SECRET SHOPPER_AUTH_SECRET CHECKOUT_SECRET; do
      printf '%s=%s\n' "$key" "$(openssl rand -hex 32)"
    done
  } > "$marketplace_root/app.env"
fi
[[ -s "$marketplace_root/compose.env" && -s "$marketplace_root/app.env" ]]
# shellcheck disable=SC1091
source "$marketplace_root/compose.env"
compose() {
  APP_REVISION="$rev" docker compose --env-file "$marketplace_root/compose.env" -f "$release/deploy/compose.marketplace.yaml" "$@"
}
pg() {
  compose exec -T db "$@"
}
compose up -d --wait --wait-timeout 60 db
if [[ $(pg psql -X -U postgres -d "$db" -Atqc "SELECT count(*) FROM pg_roles WHERE rolname='$db_user'") == 0 ]]; then
  {
    printf "CREATE ROLE %s LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '%s';\n" "$db_user" "$MARKETPLACE_DB_PASSWORD"
    printf 'ALTER DATABASE "%s" OWNER TO "%s";\n' "$db" "$db_user"
  } | pg psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db"
fi
if [[ -n "$previous" ]]; then
  backup="$marketplace_root/backups/$(date -u +%Y%m%dT%H%M%SZ)-${previous##*/}.dump"
  pg pg_dump -Fc --no-owner -U "$db_user" "$db" > "$backup.tmp"
  pg pg_restore --list < "$backup.tmp" > /dev/null
  mv "$backup.tmp" "$backup"
fi
docker run --rm --network griipbuddy-marketplace-dev_database --env-file "$marketplace_root/app.env" \
  -v "$release/prisma:/app/prisma:ro" -v "$release/prisma7.config.ts:/app/prisma7.config.ts:ro" \
  "$operator" npm run db:migrate

products=$(pg psql -X -U "$db_user" -d "$db" -Atqc 'SELECT count(*) FROM "Product" WHERE "marketplaceShopId" IS NULL')
if [[ "$products" == 0 ]]; then
  [[ -s "$catalog" ]]
  pg pg_restore --list < "$catalog" | awk '
    $4 == "TABLE" && $5 == "DATA" {
      if ($6 != "public" || $7 !~ /^(Department|Product|ProductImage|Variant|MarketOffer|Inventory|CatalogMedia|Collection|CollectionProduct)$/) exit 1;
      found++
    }
    END {if (found != 9) exit 1}'
  pg pg_restore --exit-on-error --single-transaction --no-owner --data-only -U "$db_user" -d "$db" < "$catalog"
fi
pg psql -X -v ON_ERROR_STOP=1 -U "$db_user" -d "$db" < "$release/deploy/marketplace-checkout.sql"

rollback() {
  if [[ -n "${config_backup:-}" ]]; then
    cp --preserve=mode,ownership "$config_backup" "$nginx_site"
    nginx -t && systemctl reload nginx || true
  fi
  if [[ -n "$previous" ]]; then
    APP_REVISION="${previous##*/}" docker compose --env-file "$marketplace_root/compose.env" \
      -f "$previous/deploy/compose.marketplace.yaml" up -d --wait --wait-timeout 70 app || true
  else
    compose stop app || true
  fi
}
trap 'status=$?; rollback; exit "$status"' ERR
compose up -d --wait --wait-timeout 90 app
curl --fail --silent --show-error http://127.0.0.1:4401/marketplace/api/health
printf '\n'

if ! grep -Fq 'include /opt/griipbuddy-marketplace-dev/marketplace-nginx.inc;' "$nginx_site"; then
  config_backup="$marketplace_root/backups/griipbuddy-public-build.before-marketplace"
  cp --preserve=mode,ownership "$nginx_site" "$config_backup"
  install -m 0644 "$release/deploy/marketplace-nginx.inc" "$marketplace_root/marketplace-nginx.inc"
  next=$(mktemp "$marketplace_root/.nginx.XXXXXXXX")
  awk -v marketplace_methods="$marketplace_methods" '
    /^map "\$request_method:\$uri" \$griipbuddy_public_method_denied \{/ {
      print "map $request_method $griipbuddy_marketplace_write_key { default \"\"; POST $binary_remote_addr; }"
      print "limit_req_zone $griipbuddy_marketplace_write_key zone=griipbuddy_dev_marketplace_writes:1m rate=24r/s;"
      print
      print marketplace_methods
      guard++
      next
    }
    /include \/opt\/griipbuddy-pilot-stage\/pilot-storefront.nginx;/ {
      print
      print "    include /opt/griipbuddy-marketplace-dev/marketplace-nginx.inc;"
      route++
      next
    }
    {print}
    END { if (guard != 1 || route != 1) exit 1 }
  ' "$nginx_site" > "$next"
  install -m 0644 "$next" "$nginx_site"
  rm "$next"
  nginx -t
  systemctl reload nginx
elif ! grep -Fxq "$marketplace_methods" "$nginx_site"; then
  config_backup="$marketplace_root/backups/griipbuddy-public-build.pre-$rev"
  cp --preserve=mode,ownership "$nginx_site" "$config_backup"
  next=$(mktemp "$marketplace_root/.nginx.XXXXXXXX")
  awk -v marketplace_methods="$marketplace_methods" '
    /^    ~\^POST:\/marketplace\/\(api\// {
      print marketplace_methods
      replaced++
      next
    }
    {print}
    END { if (replaced != 1) exit 1 }
  ' "$nginx_site" > "$next"
  install -m 0644 "$next" "$nginx_site"
  rm "$next"
  nginx -t
  systemctl reload nginx
fi
public_health=""
for attempt in {1..12}; do
  if result=$(curl --fail --silent --max-time 6 --resolve dev.griipbuddy.com:443:127.0.0.1 \
    https://dev.griipbuddy.com/marketplace/api/health) && [[ "$result" == *"\"revision\":\"$rev\""* ]]; then
    public_health="$result"
    break
  fi
  sleep 1
done
[[ -n "$public_health" ]]
printf '%s\n' "$public_health"
ln -s "$release" "$marketplace_root/.current.$rev"
mv -Tf "$marketplace_root/.current.$rev" "$marketplace_root/current"
trap - ERR
printf 'Active marketplace revision %s\n' "$rev"
