#!/usr/bin/env bash
set -euo pipefail
umask 077

root=/opt/griipbuddy-hybrid-demo
site=/etc/nginx/sites-available/griipbuddy-public-build
base_image=node@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752
archive=${1:?Provide the hybrid storefront source archive}
catalog=${2:-}

[[ $(id -u) == 0 && -s "$archive" && -f "$site" ]]
install -d -m 0700 "$root" "$root/releases" "$root/backups"
exec 9>"$root/deploy.lock"
flock -n 9
revision=$(sha256sum "$archive" | cut -c1-20)
release="$root/releases/$revision"
previous=""
[[ ! -L "$root/current" ]] || previous=$(readlink -f "$root/current")

if [[ ! -d "$release" ]]; then
  unpack=$(mktemp -d "$root/.unpack.XXXXXXXX")
  tar -xzf "$archive" -C "$unpack" --no-same-owner --no-same-permissions
  mv "$unpack" "$release"
fi
[[ -f "$release/Dockerfile" && ! -e "$release/.env" ]]
image="griipbuddy-hybrid-demo:$revision"
operator="griipbuddy-hybrid-demo:operator-$revision"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker build --progress plain --target runtime --build-arg "NODE_IMAGE=$base_image" \
    --build-arg HYBRID_STOREFRONT_BUILD=1 -t "$image" "$release"
fi
if [[ "${HYBRID_BUILD_ONLY:-0}" == 1 ]]; then
  printf 'Built hybrid candidate %s.\n' "$revision"
  exit 0
fi
IFS= read -r demo_password
[[ "$demo_password" =~ ^[0-9]{8}$ ]]

if [[ ! -e "$root/app.env" && ! -e "$root/compose.env" ]]; then
  [[ -z "$previous" && -s "$catalog" ]]
  printf 'HYBRID_DB_ADMIN_PASSWORD=%s\nHYBRID_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > "$root/compose.env"
  source "$root/compose.env"
  {
    printf '%s\n' 'COMMERCE_MODE=staging' 'GRIIP_MARKETPLACE_PREVIEW=1' 'GRIIP_HYBRID_STOREFRONT=1' \
      'MARKETPLACE_TEST_INTAKE_OPEN=1' 'TRUSTED_CLIENT_IP_HEADER=x-forwarded-for' 'BETTER_AUTH_URL=https://dev.griipbuddy.com' \
      'ACQUISITION_MEASUREMENT=0' 'MARKETPLACE_PAYPAL_US_TEST_SHIPPING_MINOR=695' \
      'MARKETPLACE_SSLCOMMERZ_STORE_ID=testbox' 'MARKETPLACE_SSLCOMMERZ_STORE_PASSWORD=qwerty'
    printf 'DATABASE_URL=postgresql://griipbuddy_demo:%s@db:5432/griipbuddy_hybrid_demo\n' "$HYBRID_DB_PASSWORD"
    for name in BETTER_AUTH_SECRET SHOPPER_AUTH_SECRET CHECKOUT_SECRET; do
      printf '%s=%s\n' "$name" "$(openssl rand -hex 32)"
    done
    printf 'SHOPPER_DEMO_PHONE_CODE=%06d\n' "$(( (RANDOM * 32768 + RANDOM) % 1000000 ))"
  } > "$root/app.env"
fi
[[ -s "$root/app.env" && -s "$root/compose.env" ]]
source "$root/compose.env"
compose() {
  APP_REVISION="$revision" docker compose --env-file "$root/compose.env" -f "$release/deploy/compose.hybrid-demo.yaml" "$@"
}
pg() { compose exec -T db "$@"; }
compose up -d --wait --wait-timeout 65 db
if [[ $(pg psql -X -U postgres -d griipbuddy_hybrid_demo -Atqc "SELECT count(*) FROM pg_roles WHERE rolname='griipbuddy_demo'") == 0 ]]; then
  {
    printf "CREATE ROLE griipbuddy_demo LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '%s';\n" "$HYBRID_DB_PASSWORD"
    printf 'ALTER DATABASE griipbuddy_hybrid_demo OWNER TO griipbuddy_demo;\n'
  } | pg psql -X -v ON_ERROR_STOP=1 -U postgres -d griipbuddy_hybrid_demo
fi
if [[ ! -f "$root/catalog-imported" ]]; then
  [[ -s "$catalog" ]]
  pg pg_restore --list < "$catalog" | awk '
    $4 == "TABLE" && $5 == "DATA" {
      if ($6 != "public" || $7 !~ /^(Department|Product|ProductImage|Variant|MarketOffer|Inventory|CatalogMedia|Collection|CollectionProduct)$/) exit 1;
      found++
    }
    END { if (found != 9) exit 1 }'
fi
if ! docker image inspect "$operator" >/dev/null 2>&1; then
  docker build --progress plain --target operator --build-arg "NODE_IMAGE=$base_image" -t "$operator" "$release"
fi

operate() { docker run --rm -i --network griipbuddy-hybrid-demo_database --env-file "$root/app.env" "$@"; }
if [[ -n "$previous" ]]; then
  backup="$root/backups/$(date -u +%Y%m%dT%H%M%SZ)-${previous##*/}.dump"
  pg pg_dump -Fc --no-owner -U griipbuddy_demo griipbuddy_hybrid_demo > "$backup.tmp"
  pg pg_restore --list < "$backup.tmp" > /dev/null
  mv "$backup.tmp" "$backup"
fi
operate "$operator" npm run db:migrate
if [[ ! -f "$root/catalog-imported" ]]; then
  pg pg_restore --exit-on-error --single-transaction --no-owner --data-only -U griipbuddy_demo -d griipbuddy_hybrid_demo < "$catalog"
  touch "$root/catalog-imported"
fi
printf '%s\n' "$demo_password" | operate -e ALLOW_DEMO_SEED=1 "$operator" ./node_modules/.bin/tsx scripts/seed-hybrid-demo.ts
unset demo_password
compose up -d --wait --wait-timeout 90 app
curl -fsS --max-time 8 http://127.0.0.1:4402/api/health
printf '\n'
if [[ "${HYBRID_LOOPBACK_ONLY:-0}" == 1 ]]; then exit 0; fi

backup="$root/backups/nginx-pre-$revision.conf"
config=$(mktemp "$root/.nginx.XXXXXXXX")
cp --preserve=mode,ownership "$site" "$backup"
if [[ ! -e "$root/bangladesh-prefixes.conf" ]]; then
  geo=$(mktemp "$root/.geo.XXXXXXXX")
  curl -fsS --max-time 25 https://ftp.apnic.net/stats/apnic/delegated-apnic-latest |
    python3 "$release/deploy/bangladesh-country-hint.py" > "$geo"
  install -m 0644 "$geo" "$root/bangladesh-prefixes.conf"
  rm "$geo"
fi
install -m 0644 "$release/deploy/hybrid-routes.inc" "$root/hybrid-routes.inc"
python3 - "$site" "$config" <<'PY'
from pathlib import Path
import re
import sys

source, candidate = map(Path, sys.argv[1:])
config = source.read_text()
include = "    include /opt/griipbuddy-hybrid-demo/hybrid-routes.inc;"
if include not in config:
    config, count = re.subn(
        r"    location = /admin \{ return 302[^\n]+\n(?:.|\n)*?    location / \{ proxy_pass http://127\.0\.0\.1:4368; \}",
        include,
        config,
    )
    assert count == 1
    assert config.count("v1|checkout|commerce") == 1
    config = config.replace("v1|checkout|commerce", "v1|commerce")
    marker = 'map "$request_method:$uri" $griipbuddy_public_method_denied {\n'
    assert config.count(marker) == 1
    writes = (
        r"    ~^POST:/(api/(cart/resolve|checkout(/(paypal(/webhook)?|prepaid(/callback)?))?|"
        r"marketplace(/(region|listing-photo|cases|seller/fulfillment))?|"
        r"shopper-auth/(sign-in/email|sign-up/email|sign-out|update-user|change-password|phone-number/(send-otp|verify))|"
        r"staff/(sign-in|sign-out|catalog-image|catalog-import|merchandising))|(admin|staff|seller)(/[a-z0-9/-]+)?)$ 0;"
    )
    geo = (
        "geo $griipbuddy_hybrid_country {\n"
        '    default "";\n'
        "    include /opt/griipbuddy-hybrid-demo/bangladesh-prefixes.conf;\n"
        "}\n"
    )
    config = config.replace(marker, geo + marker + writes + "\n")
candidate.write_text(config)
PY

rollback() {
  cp --preserve=mode,ownership "$backup" "$site"
  nginx -t && systemctl reload nginx || true
  if [[ -n "$previous" && "$previous" != "$release" ]]; then
    APP_REVISION="${previous##*/}" docker compose --env-file "$root/compose.env" \
      -f "$previous/deploy/compose.hybrid-demo.yaml" up -d --wait --wait-timeout 80 app || true
  fi
}
trap 'failure=$?; rollback; exit "$failure"' ERR
install -m 0644 "$config" "$site"
rm "$config"
nginx -t
systemctl reload nginx
for attempt in {1..12}; do
  health=$(curl -fsS --max-time 6 --resolve dev.griipbuddy.com:443:127.0.0.1 https://dev.griipbuddy.com/api/health) || health=""
  if [[ "$health" == *"\"revision\":\"$revision\""* ]]; then break; fi
  sleep 1
done
[[ "$health" == *"\"revision\":\"$revision\""* ]]
ln -s "$release" "$root/.current.$revision"
mv -Tf "$root/.current.$revision" "$root/current"
trap - ERR
printf 'Active hybrid demo %s\n' "$revision"
