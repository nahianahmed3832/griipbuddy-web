# Staging and operations

The new storefront uses its own Compose project, database, volume, application secrets, and access credentials. The database has an internal network and no published port. The app binds to a Hostinger loopback port. Use a separate HTTPS staging ingress. The app rejects requests without the staging review credentials and sends `X-Robots-Tag: noindex, nofollow`. Staff pages require an individual staff account in addition to the staging gate.

## Build and deploy

1. Run `npm ci` and `npm run verify` from the storefront. Run the isolated database and Chromium suites in [the README](../README.md).
2. Copy only the reviewed storefront source into `/opt/griipbuddy-storefront-stage/releases/<revision>`. Exclude local environments, credentials, generated files, dependencies, screenshots, and backups. Keep the previous release and image tags available.
3. In the staging root, copy the examples to `compose.env` and `app.env` with mode 600. Generate the database, app authentication, checkout, and review passwords independently. The database URL uses the private Compose service `db` and `griipbuddy_staging`. Set `BETTER_AUTH_URL` to the HTTPS reviewer origin. If a trusted ingress overwrites a client IP header, configure its name in the app environment. Otherwise checkout and login share a conservative unattributed rate limit.
4. Run `bash deploy/install-release.sh <revision>` from the release directory. It builds both images, waits for the database, creates a pre-migration backup, applies migrations, and checks the new app. The image label and authenticated `/api/health` return the source revision. After success, set `APP_REVISION` in the Compose environment to the value in the staging root’s `current-revision` file.
5. Use an existing authorized staging ingress or the optional Cloudflare Quick Tunnel for short-term review. A Quick Tunnel URL can change on restart. Once assigned, set it in `BETTER_AUTH_URL` and recreate only the app. Confirm a 401 without credentials, noindex, authenticated health, loaded images, staff sign-in, and the COD journey through the actual HTTPS origin. For a stable link, use a named staging hostname and ingress.

The current review endpoint is recorded in the [launch verification report](launch-verification.md). Keep the tunnel and staging database separate from any production application.

```sh
compose() { docker compose --env-file /opt/griipbuddy-storefront-stage/compose.env -f deploy/compose.yaml "$@"; }
export APP_REVISION=full-source-revision
# Once per empty staging database, if sample content is needed.
compose run --rm --no-deps -e ALLOW_DEMO_SEED=1 operator npm run db:seed
# Optional temporary ingress.
compose --profile tunnel up -d tunnel
```

Set the effective revision in the protected Compose environment or export it before operator commands. All test orders use COD and there is no online provider or callback endpoint. The app uses staged sample policy values until the owner supplies approved market rules.

## Operate the catalog and order queue

- Import products via the [catalog instructions](catalog-import.md). Check publication, price, eligibility, images, and stock on the storefront after applying changes. The owner enters market and delivery rules under **Market settings**.
- To provision staff, pipe a unique password of at least 14 characters through stdin to `compose run --rm --no-deps -T operator npm run staff:create -- owner owner@example.test "Store Owner"`. Use `packer` for packing staff. To remove access, use `compose run --rm --no-deps -T operator npm run staff:revoke -- packer@example.test`. Revocation disables the staff role and removes its sessions while retaining the audit record. Keep at least one active owner.
- Open **Orders → Packing queue**, review the delivery address and item SKUs, print the packing slip, and move the order through Packing and Ready to ship. Record the carrier and reference when marking Shipped. Mark Delivered when confirmed. The original checkout browser can refresh **Order status** to see the recorded details.
- COD stays Awaiting collection through delivery. Only an owner records cash received after confirming the amount. A customer reporting a missing order should first use the original browser. Review the order reference privately through `contact@griipbuddy.com`. Keep any failed or disputed collection for manual review. Confirm the approved refund process before launch.
- An owner can cancel an unshipped order awaiting collection. The order record is retained, COD is voided, and allocated inventory is returned once.
- Use `compose logs --tail=100 app` and the request or order reference to investigate. Checkout and staff error logs record operation, reference, and a known error code. Keep access logs and diagnostics free of request bodies, authorization headers, cookies, and customer details. Quota counters use keyed hashes. Expired checkout quota rows may be deleted by the database operator with `DELETE FROM "RequestQuota" WHERE "resetsAt" < CURRENT_TIMESTAMP`.

## Backup and recover

Run PostgreSQL custom-format dumps, then copy them to encrypted, access-controlled storage separate from the host. Set retention and backup frequency with the operator before launch. An uploaded image is normalized to WebP and stored in PostgreSQL by content hash, so the dump includes the image and its catalog references. Bundled images come from the tested release source. Restore media and catalog from the same backup.

```sh
bash deploy/backup.sh /opt/griipbuddy-storefront-stage/compose.env /absolute/path/staging.dump
bash deploy/restore-drill.sh /opt/griipbuddy-storefront-stage/compose.env /absolute/path/staging.dump GB-000000000000 product-id
```

Supply a real synthetic order reference and its product ID for the drill. It restores into a network-isolated disposable PostgreSQL container and verifies the product and order join before removing the container. If a drill fails, retain the backup and investigate before making any change to the working database.

If a release fails after migration, check the migration status and determine whether the previous app can read and write the migrated schema safely. Changing the app image does not reverse a migration. Prefer a forward fix if schema compatibility is unclear. Restore a known-good dump into a fresh database, verify it, and switch only after deciding how to retain or reconcile orders and media created after the dump. Never replace the working database during a drill.

[Prisma v7 migration workflow](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/development-and-production) · [PostgreSQL 17 backup format](https://www.postgresql.org/docs/17/app-pgdump.html) · [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting) · [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
