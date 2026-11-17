#!/usr/bin/env bash
set -euo pipefail
umask 077

revision=${1:?Usage: bash deploy/install-release.sh REVISION}
if [[ ! "$revision" =~ ^[0-9a-f]{12,64}$ ]]; then exit 2; fi
root=/opt/griipbuddy-storefront-stage
cd "$root/releases/$revision"
test -f "$root/compose.env"
test -f "$root/app.env"

bash deploy/build-images.sh "$revision"
compose=(docker compose --env-file "$root/compose.env" -f deploy/compose.yaml)
if grep -qx 'GRIIP_MERCHANDISING_ENABLED=1' "$root/app.env"; then
    compose+=(-f deploy/compose.merchandising.yaml)
fi
export APP_REVISION="$revision"
"${compose[@]}" up -d --wait --wait-timeout 90 db
mkdir -p "$root/backups"
bash deploy/backup.sh "$root/compose.env" "$root/backups/pre-${revision:0:12}-$(date -u +%Y%m%dT%H%M%SZ).dump"
"${compose[@]}" run --rm --no-deps operator
"${compose[@]}" up -d --wait --wait-timeout 120 app
printf '%s\n' "$revision" > "$root/current-revision"
