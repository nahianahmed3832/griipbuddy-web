# GriipBuddy frontend release and recovery

The new storefront is public on Hostinger. Bangladesh shoppers can add products to their cart and continue to the existing checkout on `griipbuddy.com`. That checkout calculates the final amount, accepts Cash on Delivery and sends orders to the existing fulfillment queue. [New storefront](https://frontend.griipbuddy.com/) · [Existing checkout](https://griipbuddy.com/bd/checkout)

| Market | Currency | Catalog | Stock | Delivery | Payment methods | Checkout status | Remaining blocker |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Bangladesh | BDT | 208 published products, 563 variants, 932 unique photos | 1,942 available units across 364 variants at import. Refreshed every five minutes from the Bangladesh warehouses. | Existing checkout calculates delivery by address. | Cash on Delivery available in the existing checkout | Open through the cart transfer | Live order placement was not exercised. |
| United States | USD | No published offers in the source catalog | No US allocation | Unconfigured | None | Closed | No US catalog or checkout is configured. |

## Catalog and order ownership

- The migration used the published Bangladesh website catalog from the running legacy service. It preserved product slugs and MongoDB IDs, imported variant SKUs and options, and stored 932 distinct WebP photos in PostgreSQL. Duplicate photo references share one asset. The only product with a short or missing description uses its existing title as the description.
- The stock refresh on `srv1245833` reads prices, campaign terms and sellable stock every five minutes. It subtracts reservations and excludes the China warehouse and photoshoot studio. It updates only already imported variants and withdraws offers that disappear from the source. New products, variants and photos need another import. Price and stock changes belong in the existing admin. [GriipBuddy admin](https://admin.griipbuddy.com/)
- The checkout transfer passes variant IDs and quantities to the legacy checkout. The transfer uses fresh source products and checks available stock before loading the existing order form. The frontend keeps browsing and the cart on `frontend.griipbuddy.com`. The existing checkout owns order confirmation, SMS, payment status and courier handoff. It currently displays ৳70 inside Dhaka and ৳100 outside, while the published shipping page lists ৳80 and ৳120. The live checkout remains the source for the amount the customer will pay. [Published shipping policy](https://griipbuddy.com/shipping-procedure)
- The production frontend remains excluded from search indexing while its separate policy file is incomplete. Its help pages link to the existing store’s shipping, returns, privacy and terms pages. The storefront is accessible without credentials.

## Deployment and verification

- Hostinger VPS `srv1245833` runs Compose project `griipbuddy-storefront-prod` on loopback port `4398`. The active application revision is `e938ad3d52c7f54229662d1cc4b76a81903bf974` and the image is `sha256:30e1f4015087b11ea226b2d74f306c9b8a88e3f8b4e5d769a1740a42708904a9`. The source bundle and lockfile are retained in `.local/releases`.
- The existing PostgreSQL database `griipbuddy_production` retains its restricted app role. The import ran in one transaction after a pre-import backup and verified every media hash. No new schema migration or production seed was needed. The import report, SQL and verified backups are under `/opt/griipbuddy-storefront-prod` on Hostinger.
- The Hostinger Docker build, 15 PostgreSQL tests and 18 local browser scenarios passed. Brave tested browsing and pagination at desktop and mobile sizes, live WebP delivery, the original BDT price and availability of a real SKU, cart transfer, the Cash on Delivery option and the US checkout block. A disposable copy with intake paused rejected the transfer on the server. Test browsing stopped before order submission.
- The opening observation ran from 01:17 to 01:32 on November 14, 2026 (Asia/Shanghai). The storefront, existing checkout and admin returned 200, the scheduled refresh ran successfully, and the frontend reported zero application errors. No Bangladesh COD order appeared in the source during the observation. A promotional item displayed ৳455 on both the new product page and the existing checkout.
- The transfer page and script are served only at `/bd/checkout/transfer` and `/bd/checkout/transfer.js` on the legacy domain. The site reads existing public catalog and stock endpoints. Its Nginx include and the previous vhost are under the production root. Checkout, staff and customer records remain with the legacy application.

## Pause and recover

- Set `ORDER_INTAKE_OPEN=0` in `/opt/griipbuddy-storefront-prod/app.env` and recreate only the frontend app with the running revision. A server check then stops new checkout transfers. Orders already placed stay in the existing fulfillment queue. The main store continues to take orders under its own configuration.
- Check `journalctl -u griipbuddy-catalog-refresh.service` for price or stock refresh errors. Run `systemctl start griipbuddy-catalog-refresh.service` for an immediate refresh and `systemctl list-timers griipbuddy-catalog-refresh.timer` for the next scheduled run.
- To recreate the current app, set `APP_REVISION` from `/opt/griipbuddy-storefront-prod/current-revision`, use that release directory and run `docker compose --env-file /opt/griipbuddy-storefront-prod/compose.env -f deploy/compose.production.yaml up -d --no-deps --wait app`. The root route can temporarily use the maintenance include at `deploy/frontend-release-maintenance.nginx`.
- For a database recovery, restore into a separate instance, recreate the app role and apply `deploy/production-grants.sql` before switching traffic. Preserve newer records and media. The production order system has its own recovery procedure and does not use the catalog backup for order recovery.

[Staging verification](launch-verification.md) · [Staff and order operations](operations.md)
