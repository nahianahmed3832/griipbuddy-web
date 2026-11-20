#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

marketplace_root=/opt/griipbuddy-marketplace-dev
nginx_site=/etc/nginx/sites-available/griipbuddy-public-build
marketplace_include="$marketplace_root/marketplace-nginx.inc"
operator=${MARKETPLACE_MIGRATION_IMAGE:-griipbuddy-storefront-stage-operator:35b731525ce5c72682f32e4a5fdb4a4ded52d496}
db=griipbuddy_marketplace_dev
db_user=griipbuddy_marketplace
marketplace_methods='    ~^POST:/marketplace/(api/(cart/resolve|checkout(/(paypal(/webhook)?|prepaid(/callback)?))?|measurement|newsletter|notifications|recommendations|recommendation-preferences|marketplace(/(region|listing-photo|cases|seller/(catalog|fulfillment|listings)))?|shopper-auth/(sign-in/email|sign-up/email|sign-out|update-user|change-password)|staff/(sign-in|sign-out|catalog(/context|/feed-export)?|catalog-image|catalog-import|merchandising|intelligence/analyst|workflows/agent))|staff(/[a-z0-9/-]+)?)$ 0;'
base_image=node@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752
archive=${1:?Provide the marketplace source archive}
catalog=${2:-}
source_sha=${MARKETPLACE_SOURCE_SHA:-}
update_only=${MARKETPLACE_UPDATE_ONLY:-0}

previous_marketplace_mode() {
  local expected_image=$1 container image mode
  container=$(docker ps --filter label=com.docker.compose.project=griipbuddy-marketplace-dev \
    --filter label=com.docker.compose.service=app --format '{{.ID}}') || return 1
  [[ "$container" =~ ^[a-f0-9]{12,64}$ ]] || return 1
  image=$(docker inspect --format '{{.Config.Image}}' "$container") || return 1
  [[ "$image" == "$expected_image" ]] || return 1
  mode=$(docker inspect --format '{{range .Config.Env}}{{if eq (index (split . "=") 0) "GRIIP_FIRST_PARTY_STOREFRONT"}}{{println .}}{{end}}{{end}}' "$container") || return 1
  case "$mode" in
    GRIIP_FIRST_PARTY_STOREFRONT=0) printf '%s\n' 0 ;;
    GRIIP_FIRST_PARTY_STOREFRONT=1) printf '%s\n' 1 ;;
    *) return 1 ;;
  esac
}

[[ $(id -u) == 0 && -s "$archive" && -f "$nginx_site" ]]
install -d -m 0700 "$marketplace_root" "$marketplace_root/releases" "$marketplace_root/backups"
exec 9>"$marketplace_root/deploy.lock"
flock -n 9
full_sha=$(sha256sum "$archive" | cut -d ' ' -f 1)
rev=${full_sha:0:20}
release="$marketplace_root/releases/$rev"
previous=""
if [[ -L "$marketplace_root/current" ]]; then previous=$(readlink -f "$marketplace_root/current"); fi
if [[ "$update_only" == 1 ]]; then
  [[ "$previous" == "$marketplace_root"/releases/* && -s "$marketplace_root/app.env" && -s "$marketplace_root/compose.env" ]]
fi
if [[ -n "$source_sha" ]]; then [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]; fi
if [[ -n "$previous" && "$previous" == "$release" ]]; then
  printf 'Revision %s is already active.\n' "$rev"
  exit 0
fi
previous_first_party=1
if [[ "$update_only" == 1 ]]; then
  if ! previous_first_party=$(previous_marketplace_mode "griipbuddy-marketplace-dev:${previous##*/}"); then
    printf '%s\n' 'Cannot record the running development image and storefront mode for rollback.' >&2
    exit 1
  fi
elif [[ -n "$previous" && -s "$previous/development.env" ]]; then
  previous_first_party=0
fi
if ! [[ -d "$release" ]]; then
  unpack=$(mktemp -d "$marketplace_root/.unpack.XXXXXXXX")
  tar --extract --gzip --file "$archive" --directory "$unpack" --no-same-owner --no-same-permissions
  mv "$unpack" "$release"
fi
[[ -f "$release/Dockerfile" && -f "$release/deploy/compose.marketplace.yaml" && ! -e "$release/.env" ]]
if [[ -n "${MARKETPLACE_ACCEPTANCE_FILE:-}" ]]; then
  [[ "$update_only" == 1 && -s "$MARKETPLACE_ACCEPTANCE_FILE" ]]
  install -m 0600 "$MARKETPLACE_ACCEPTANCE_FILE" "$release/development.env"
fi
if [[ -n "$source_sha" ]]; then printf '%s\n' "$source_sha" > "$release/source-commit"; fi
if [[ -n "$previous" ]]; then printf '%s\n' "$previous" > "$release/previous-release"; fi
if [[ -n "$previous" ]]; then printf '%s\n' "$previous_first_party" > "$release/previous-first-party"; fi

if ! docker image inspect "griipbuddy-marketplace-dev:$rev" >/dev/null 2>&1; then
  [[ "${MARKETPLACE_PREBUILT:-0}" != 1 ]]
  docker build --progress plain --target runtime --build-arg "NODE_IMAGE=$base_image" \
    --build-arg NEXT_PUBLIC_STOREFRONT_BASE_PATH=/marketplace --label "org.opencontainers.image.revision=$source_sha" \
    --tag "griipbuddy-marketplace-dev:$rev" "$release"
fi
if [[ -n "$source_sha" ]]; then
  [[ $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "griipbuddy-marketplace-dev:$rev") == "$source_sha" ]]
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
  APP_REVISION="$rev" MARKETPLACE_ACCEPTANCE_ENV="$release/development.env" \
    MARKETPLACE_FIRST_PARTY_ONLY="${MARKETPLACE_FIRST_PARTY_ONLY:-1}" \
    docker compose --env-file "$marketplace_root/compose.env" -f "$release/deploy/compose.marketplace.yaml" "$@"
}
pg() {
  compose exec -T db "$@"
}
if [[ "$update_only" == 1 ]]; then
  pg pg_isready -q -U "$db_user" -d "$db"
else
  compose up -d --wait --wait-timeout 60 db
fi
if [[ $(pg psql -X -U postgres -d "$db" -Atqc "SELECT count(*) FROM pg_roles WHERE rolname='$db_user'") == 0 ]]; then
  [[ "$update_only" != 1 ]]
  {
    printf "CREATE ROLE %s LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '%s';\n" "$db_user" "$MARKETPLACE_DB_PASSWORD"
    printf 'ALTER DATABASE "%s" OWNER TO "%s";\n' "$db" "$db_user"
  } | pg psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db"
fi
if [[ -n "${MARKETPLACE_RESUME_BACKUP:-}" ]]; then
  [[ "$update_only" == 1 && "$MARKETPLACE_RESUME_BACKUP" == "$marketplace_root"/backups/*.dump ]]
  backup=$(readlink -f "$MARKETPLACE_RESUME_BACKUP")
  [[ "$backup" == "$marketplace_root"/backups/*.dump && -s "$backup" && -s "$backup.sha256" ]]
  sha256sum -c --status "$backup.sha256"
  pg pg_restore --list < "$backup" > /dev/null
  printf '%s\n' "$backup" > "$release/database-backup"
elif [[ -n "$previous" ]]; then
  backup="$marketplace_root/backups/$(date -u +%Y%m%dT%H%M%SZ)-${previous##*/}.dump"
  pg pg_dump -Fc --no-owner -U "$db_user" "$db" > "$backup.tmp"
  pg pg_restore --list < "$backup.tmp" > /dev/null
  mv "$backup.tmp" "$backup"
  sha256sum "$backup" > "$backup.sha256"
  printf '%s\n' "$backup" > "$release/database-backup"
fi
prisma_command=(npm run db:migrate)
if [[ -n "${MARKETPLACE_RESUME_BACKUP:-}" ]]; then prisma_command=(./node_modules/.bin/prisma migrate status); fi
docker run --rm --network griipbuddy-marketplace-dev_database --env-file "$marketplace_root/app.env" \
  -v "$release/prisma:/app/prisma:ro" -v "$release/prisma7.config.ts:/app/prisma7.config.ts:ro" \
  "$operator" "${prisma_command[@]}"

if [[ "$update_only" != 1 ]]; then
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
fi

if [[ "${MARKETPLACE_PREPARE_OPERATOR:-0}" == 1 ]]; then
  [[ "$update_only" == 1 && -s "$release/development.env" ]]
  if [[ ! -L "$release/node_modules" ]]; then ln -s /app/node_modules "$release/node_modules"; fi
  [[ $(readlink "$release/node_modules") == /app/node_modules ]]
  docker run --rm --network griipbuddy-marketplace-dev_database \
    --env-file "$marketplace_root/app.env" --env-file "$release/development.env" \
    --mount "type=bind,source=$release,target=/review" --workdir /review \
    --memory 650m --cpus 0.80 "$operator" npm run db:generate
  [[ -s "$release/src/generated/prisma/client.ts" ]]
fi

rollback() {
  if [[ -n "${config_backup:-}" ]]; then
    cp --preserve=mode,ownership "$config_backup" "$nginx_site"
  fi
  if [[ -n "${include_backup:-}" ]]; then
    cp --preserve=mode,ownership "$include_backup" "$marketplace_include"
  elif [[ "${include_added:-0}" == 1 ]]; then
    rm -f -- "$marketplace_include"
  fi
  if [[ -n "${config_backup:-}${include_backup:-}" || "${include_added:-0}" == 1 ]]; then
    nginx -t && systemctl reload nginx || true
  fi
  if [[ -n "$previous" ]]; then
    APP_REVISION="${previous##*/}" MARKETPLACE_ACCEPTANCE_ENV="$previous/development.env" MARKETPLACE_FIRST_PARTY_ONLY="$previous_first_party" \
      docker compose --env-file "$marketplace_root/compose.env" \
      -f "$previous/deploy/compose.marketplace.yaml" up -d --wait --wait-timeout 70 app || true
  else
    compose stop app || true
  fi
}
trap 'status=$?; trap - ERR; set +e; rollback; exit "$status"' ERR
compose up -d --wait --wait-timeout 90 app
curl --fail --silent --show-error http://127.0.0.1:4401/marketplace/api/health
printf '\n'

nginx_changed=0
if ! cmp -s "$release/deploy/marketplace-nginx.inc" "$marketplace_include"; then
  if [[ -f "$marketplace_include" ]]; then
    include_backup="$marketplace_root/backups/marketplace-nginx.inc.pre-$rev"
    cp --preserve=mode,ownership "$marketplace_include" "$include_backup"
  else
    include_added=1
  fi
  next=$(mktemp "$marketplace_root/.nginx.XXXXXXXX")
  install -m 0644 "$release/deploy/marketplace-nginx.inc" "$next"
  mv -Tf "$next" "$marketplace_include"
  nginx_changed=1
fi

if ! grep -Fq 'include /opt/griipbuddy-marketplace-dev/marketplace-nginx.inc;' "$nginx_site"; then
  config_backup="$marketplace_root/backups/griipbuddy-public-build.before-marketplace"
  cp --preserve=mode,ownership "$nginx_site" "$config_backup"
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
  nginx_changed=1
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
  nginx_changed=1
fi
if [[ "$nginx_changed" == 1 ]]; then
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
