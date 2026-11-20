#!/usr/bin/env bash
set -euo pipefail

env_file=${1:?Usage: bash deploy/restore-drill.sh COMPOSE_ENV BACKUP_FILE ORDER_REFERENCE PRODUCT_ID}
backup=${2:?Supply the backup file}
reference=${3:?Supply the representative order reference}
product_id=${4:?Supply the representative product ID}
if [[ ! "$reference" =~ ^GB-[A-F0-9]{12}$ || ! "$product_id" =~ ^[a-z0-9][a-z0-9-]{0,79}$ ]]; then
  printf '%s\n' 'Use a valid order reference and product ID.' >&2
  exit 2
fi

cd "$(dirname "$0")/.."
compose=(docker compose --env-file "$env_file" -f deploy/compose.yaml)
postgres_image=$("${compose[@]}" images -q db)
if [ -z "$postgres_image" ]; then
  printf '%s\n' 'Start the dedicated staging database first.' >&2
  exit 2
fi
restore_name="griipbuddy-stage-restore-$(openssl rand -hex 6)"
# Restore into a new container with no network and no mount from staging.
docker run --detach --name "$restore_name" --network none --memory 384m \
  --tmpfs /var/lib/postgresql/data:rw,size=512m \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=griipbuddy_restore \
  "$postgres_image" > /dev/null
trap 'docker rm -f "$restore_name" >/dev/null' EXIT
for attempt in {1..30}; do
  if docker exec "$restore_name" pg_isready -q -h 127.0.0.1 -U postgres -d griipbuddy_restore; then break; fi
  sleep 1
done
docker exec -i "$restore_name" pg_restore --exit-on-error --no-owner --no-privileges -U postgres -d griipbuddy_restore < "$backup"
docker exec -i "$restore_name" psql -X -v ON_ERROR_STOP=1 -v product_id="$product_id" -v reference="$reference" \
  -U postgres -d griipbuddy_restore <<'SQL'
SELECT count(*) AS products, (SELECT count(*) FROM "CatalogMedia") AS uploaded_images FROM "Product";
SELECT p."id", p."publication", count(DISTINCT v."sku") AS variants
FROM "Product" p JOIN "Variant" v ON v."productId" = p."id"
WHERE p."id" = :'product_id' GROUP BY p."id";
SELECT o."reference", o."totalMinor", o."currency", o."fulfillmentStatus", pay."status" AS payment_status
FROM "Order" o JOIN "Payment" pay ON pay."orderId" = o."id" JOIN "OrderItem" i ON i."orderId" = o."id"
JOIN "Variant" v ON v."id" = i."variantId"
WHERE o."reference" = :'reference' AND v."productId" = :'product_id';
SELECT EXISTS (
  SELECT 1 FROM "Order" o JOIN "OrderItem" i ON i."orderId" = o."id"
  JOIN "Variant" v ON v."id" = i."variantId" JOIN "Payment" pay ON pay."orderId" = o."id"
  WHERE o."reference" = :'reference' AND v."productId" = :'product_id'
) AS restored \gset
\if :restored
  \echo 'Representative catalog and order verified in the disposable database.'
\else
  \echo 'Representative catalog or order missing.'
  SELECT 1 / 0;
\endif
SQL
