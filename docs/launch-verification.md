# Launch candidate verification

The GriipBuddy storefront runs in an isolated Compose project on Hostinger. The review URL is password protected. Use the reviewer credentials from the ignored local file `.local/staging-review.env`, then sign in to Staff as the owner or packer from that same file. The current review URL uses a temporary Cloudflare Quick Tunnel.

[Staging storefront](https://photographic-geological-inventory-wood.trycloudflare.com/) · [Staff sign-in](https://photographic-geological-inventory-wood.trycloudflare.com/staff/login)

## Release

The source revision for this candidate is `ff198e897fea89c12c344fbaee89c07116ea12bc`. The complete source is available as a local storefront-only Git bundle in `.local/releases/`. The application image label and authenticated `/api/health` identify the running revision. The database and media are stored in a dedicated PostgreSQL volume and contain synthetic products and orders.

## Test scope

- The previous milestone passed all 16 browser scenarios before changes. [Milestone 2 verification](verification.md)
- `npm ci` and `npm run verify` passed. The verification gate runs lint, TypeScript, three unit tests, and the Next.js production build. The Linux build passed without access to the database. Both migrations applied to an empty staging database, and the app and database health checks passed.
- `GRIIPBUDDY_ENV_FILE=.env.test npm run test:integration` passed all 14 PostgreSQL tests. These cover server pricing, concurrent checkout and cancellation, stock preservation, row-level import errors, repeated import, changes to delivery terms, and authorization.
- `npm run test:e2e:database` passed all 18 local production Chromium scenarios at desktop 1440 px and narrow mobile 320 px. These include the existing browser regressions and the new launch journey.
- `CAPTURE_STOREFRONT_SCREENSHOTS=1 npm run test:e2e -- tests/launch.spec.ts --workers=2` passed both hosted scenarios with the staging URL and review and staff credentials in the environment. The scenarios cover import preview and application, invalid currency, duplicate import, stock adjustment, uploaded image delivery, customer checkout and replay, unsupported delivery area, guest and staff access, packing, and shipment details as seen by the customer.
- Requests without staging credentials returned 401 with `X-Robots-Tag: noindex, nofollow` for pages, API and media. Authenticated HTTPS health returned the tested revision and database status `ok`.
- A separate 320 px hosted check created a product draft from the owner form, confirmed incomplete publication was rejected, and verified the saved draft stayed off the storefront. The market settings screen showed the Dhaka fixture fee and disabled US checkout with tax unconfigured.

The initial local checks exposed test selectors that matched multiple elements and a test that modified another suite’s delivery fixture. Those tests were narrowed and the fixtures isolated. The first hosted runs also exposed a timing issue when editing products and refreshing order status on a slower connection. The final release waits for the editor to become interactive and submits a standard browser navigation for a status refresh. The database adapter continues to emit a pg deprecation warning.

| Hosted journey | Product and variant | Saved order | Amount and outcome |
| --- | --- | --- | --- |
| Desktop | `stage-tote-6f689cc6` · `STAGE-6F689CC6-OAT` | `GB-200F2B6C33E7` | ৳1,392.50 · Delivered · Awaiting collection · `STAGING-6F689CC6` |
| Mobile | `stage-tote-ea420d17` · `STAGE-EA420D17-OAT` | `GB-E9E371CE2547` | ৳1,392.50 · Delivered · Awaiting collection · `STAGING-EA420D17` |

## Restore drill

`deploy/backup.sh` dumped the hosted staging database. `deploy/restore-drill.sh` restored it into a disposable PostgreSQL container with no network or shared storage. The restored database contained 30 products and one uploaded image. The drill read the desktop acceptance product, both variants, and order `GB-200F2B6C33E7` with the saved total of ৳1,392.50 and states Delivered and Awaiting collection. The temporary container was removed. The source database remained available.

An earlier local drill also verified the uploaded WebP bytes and the carrier references for two delivered orders.

## Screenshots

Captured from the hosted production build using synthetic records.

| Screen | Desktop | Mobile |
| --- | --- | --- |
| Storefront | [Desktop](screenshots/launch-storefront-desktop.jpg) | [Mobile](screenshots/launch-storefront-mobile.jpg) |
| Product editor | [Desktop](screenshots/launch-product-editor-desktop.jpg) | [Mobile](screenshots/launch-product-editor-mobile.jpg) |
| Import preview | [Desktop](screenshots/launch-import-desktop.jpg) | [Mobile](screenshots/launch-import-mobile.jpg) |
| Checkout | [Desktop](screenshots/launch-checkout-desktop.jpg) | [Mobile](screenshots/launch-checkout-mobile.jpg) |
| Confirmation | [Desktop](screenshots/launch-confirmation-desktop.jpg) | [Mobile](screenshots/launch-confirmation-mobile.jpg) |
| Packing | [Desktop](screenshots/launch-packing-desktop.jpg) | [Mobile](screenshots/launch-packing-mobile.jpg) |
| Customer shipment status | [Desktop](screenshots/launch-tracking-desktop.jpg) | [Mobile](screenshots/launch-tracking-mobile.jpg) |

## Launch readiness

| Area | Status | Evidence | Missing input or action |
| --- | --- | --- | --- |
| Catalog management and CSV import | Ready for staging review | Owner editor and preview, per-product transactions, photo upload, and repeat import checks | Supply a launch catalog with stable IDs, SKUs, descriptions, attributes, approved brand assets and photos, market prices, and verified available stock. |
| Bangladesh COD | Ready for staging review | Sample orders, authoritative quotes, duplicate and inventory checks, and independent cash collection | Approve the real delivery districts, delivery fees and timing, tax treatment, COD eligibility and reconciliation. The test schedule is ৳80 Dhaka and ৳130 Chattogram with 5% demo tax. |
| Manual packing and shipment | Ready for staging review | Staff roles, shipment history, packing slip, and customer-facing carrier and reference | Confirm the operating carrier, handoff responsibilities, and failed-delivery procedure. |
| Customer information | Blocked for publication | Footer links, guest order history, and draft help pages. Support uses contact@griipbuddy.com. | Approve seller details and support ownership, privacy retention and rights handling, terms, cancellation timing, return eligibility and address, and refund timing and method. |
| Controlled production release | Blocked | Password-protected staging uses a separate database, credentials, and URL | Confirm launch scope and authorization. Configure a stable production ingress and the backup schedule, retention, and off-host copy. |
| US checkout and online payments | Deferred for Bangladesh COD scope | USD browsing is available. Checkout and payment methods are enforced on the server. | Supply market-specific checkout rules for the US, and a selected merchant sandbox if online payments enter scope. |
| Transactional email and courier automation | Deferred | Support email and manual tracking are available | Configure a development mail sink and approve a provider only if needed for the intended release. |

[CSV template](../public/templates/catalog-template.csv) · [Staging example](../public/templates/catalog-example.csv) · [Import instructions](catalog-import.md) · [Deployment and operations runbook](operations.md)
