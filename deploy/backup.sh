#!/usr/bin/env bash
set -euo pipefail
umask 077

env_file=${1:?Usage: bash deploy/backup.sh COMPOSE_ENV NEW_BACKUP_FILE}
backup=${2:?Supply a new backup filename}
cd "$(dirname "$0")/.."
compose=(docker compose --env-file "$env_file" -f "${GRIIPBUDDY_COMPOSE_FILE:-deploy/compose.yaml}")
if [ -e "$backup" ]; then
  printf '%s\n' 'Choose a new backup filename.' >&2
  exit 2
fi
temporary=$(mktemp "${backup}.partial.XXXXXXXX")
trap 'rm -f -- "$temporary"' EXIT
"${compose[@]}" exec -T db sh -eu -c 'pg_dump --format=custom --no-owner --no-privileges -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$temporary"
"${compose[@]}" exec -T db pg_restore --list < "$temporary" > /dev/null
ln -- "$temporary" "$backup"
printf 'Created backup %s\n' "$backup"
