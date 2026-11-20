#!/usr/bin/env bash
set -euo pipefail
umask 077

root=/opt/griipbuddy-marketplace-dev
operator=griipbuddy-hybrid-demo:operator-94b92e89858f10e24aa1
release=$(readlink -f "$root/current")
[[ "$release" == "$root"/releases/* && -s "$root/app.env" && -s "$release/development.env" ]]
[[ -s "$release/src/generated/prisma/client.ts" && $(readlink "$release/node_modules") == /app/node_modules ]]

exec 9>"$root/jobs.lock"
flock -n 9 || exit 0
state="$root/jobs-state"
install -d -m 0700 "$state"

run() {
  docker run --rm --network griipbuddy-marketplace-dev_database \
    --env-file "$root/app.env" --env-file "$release/development.env" \
    -e NEXT_PUBLIC_STOREFRONT_BASE_PATH=/marketplace \
    --mount "type=bind,source=$release,target=/review,readonly" --workdir /review \
    --memory 450m --cpus 0.75 "$operator" /app/node_modules/.bin/tsx "$@"
}

once_per_slot() {
  local interval_seconds=$1 state_file=$2 script=$3 previous='' epoch slot
  epoch=$(date -u +%s)
  slot=$((epoch / interval_seconds))
  if [[ -r "$state_file" ]]; then IFS= read -r previous < "$state_file" || true; fi
  if [[ "$previous" == "$slot" ]]; then return 0; fi
  if ! run "$script"; then return 1; fi
  printf '%s\n' "$slot" > "$state_file.next" && mv -T "$state_file.next" "$state_file"
}

status=0
run scripts/expire-development-inventory-reservations.ts || status=1
run scripts/run-operational-workflows.ts --test || status=1
run scripts/run-notification-jobs.ts || status=1
once_per_slot 3600 "$state/product-intelligence" scripts/observe-product-intelligence.ts || status=1
once_per_slot 900 "$state/measurement-retention" scripts/prune-development-measurement.ts || status=1
exit "$status"
