#!/usr/bin/env bash
set -euo pipefail
umask 077

revision=${1:?Usage: bash deploy/install-production.sh REVISION}
if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then exit 2; fi
root=/opt/griipbuddy-storefront-prod
cd "$root/releases/$revision"
test -f "$root/compose.env"
test -f "$root/operator.env"
test -f "$root/app.env"
test -f "$root/policies.json"
export APP_REVISION="$revision" GRIIPBUDDY_COMPOSE_FILE=deploy/compose.production.yaml
compose() { docker compose --env-file "$root/compose.env" -f "$GRIIPBUDDY_COMPOSE_FILE" "$@"; }

bash deploy/build-images.sh "$revision" production
compose up -d --wait --wait-timeout 90 db
mkdir -p "$root/backups"
bash deploy/backup.sh "$root/compose.env" "$root/backups/pre-${revision:0:12}-$(date -u +%Y%m%dT%H%M%SZ).dump"

compose run --rm --no-deps -T operator npm run db:migrate
role=$(compose exec -T db psql -X -At -U griipbuddy_prod_operator -d griipbuddy_production \
  -c "SELECT rolname FROM pg_roles WHERE rolname = 'griipbuddy_prod_app'")
if [ -z "$role" ]; then
  # The generated hex password is transferred on stdin and does not enter an argument or output.
  app_password=$(sed -n 's#^DATABASE_URL=postgresql://griipbuddy_prod_app:\([0-9a-f]\{64\}\)@db:5432/griipbuddy_production$#\1#p' "$root/app.env")
  if [[ ! "$app_password" =~ ^[0-9a-f]{64}$ ]]; then exit 2; fi
  {
    printf '%s\n' "$app_password"
    cat <<'SQL'
\getenv app_password GRIIP_APP_PASSWORD
CREATE ROLE griipbuddy_prod_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'app_password';
SQL
  } | compose exec -T db sh -eu -c '
    IFS= read -r GRIIP_APP_PASSWORD
    export GRIIP_APP_PASSWORD
    exec psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$POSTGRES_DB"
  '
  unset app_password
fi
compose exec -T db psql -X -v ON_ERROR_STOP=1 -U griipbuddy_prod_operator -d griipbuddy_production < deploy/production-grants.sql
compose up -d --wait --wait-timeout 120 app
printf '%s\n' "$revision" > "$root/current-revision"
