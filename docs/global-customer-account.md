# Global customer account

`/global-account` is the country directory and security entry. It uses the existing verified shopper identity. Opening a country saves a browser preference. Direct country links resolve to their named storefront. Language, display name, address defaults, promotions and the browser cart stay scoped to the market.

| Entry | Behavior |
| --- | --- |
| `/global-account` | Show the saved country or suggest one from the current storefront and country hint. Offer sign-in, security, recovery and the country choices. |
| `/bd/account` | Bangladesh account in Bangla or English. BDT, district addresses, COD, manual wallets, packing, tracking and owner support. |
| `/account?market=us` | US account in English. USD, US addresses, test shipping, PayPal sandbox when configured, and market-scoped staff updates and support. |
| `/account?market=ca` | Optional Canada fixture. English (Canada), CAD, province and postal validation, address book, synthetic order history and staff support. Checkout and fulfillment are closed. |
| `/orders/:id`, `/orders/recover/:id` | Receipt and private recovery in the owning storefront. The order retains its return terms, totals, currency and delivery address. |

`src/config/markets.ts` keeps market IDs independent of deployment region. Address, checkout, payment, fulfillment and locale settings come from the registry. Canada requires `GRIIP_FIXTURE_MARKET=ca` on an isolated hybrid staging or loopback instance. Grant fixture staff access explicitly. Sellers use the shopper identity and approved market grants. Staff use the existing staff sign-in and their role and market grants.

## Shared sign-in

The dev site uses one origin and the existing Better Auth shopper session. A distinct-origin acceptance environment sets `SHOPPER_IDENTITY_ORIGIN`, `SHOPPER_BD_ORIGIN` and `SHOPPER_US_ORIGIN` to exact registered origins. Each instance sets its own `BETTER_AUTH_URL`. Use HTTPS for staging and loopback HTTP for local tests. Registered storefronts pin market resolution independently of cookies and hints.

The destination starts sign-in with a browser-bound verifier. The issuer requires a verified shopper and issues a 60-second code. The destination consumes it once and creates a host-only Better Auth session. The return path preserves a supported account or order route and excludes arbitrary destinations, queries and fragments. Local sign-out applies to that storefront session. Password reset uses the existing revocation across the shared session store. The hosted preview keeps email in the owner-only inbox. Verified sign-in contact changes stay with the support workflow.

New sign-in checks issuer readiness and offers a retry if unavailable. A valid local session can continue when the issuer app is unavailable and the shared session database is reachable. A market data error offers a retry for the same storefront. Routine errors use operation and reference identifiers. The handoff responses use private cache and referrer policies. Omit query logging for `/api/shopper-handoff/` when putting it behind a separate ingress.

## Migration, rollout and rollback

1. Verify the target revision, dedicated test-only database, test intake and captured shopper email. Back up the database, app environment and route configuration. Verify the dump listing before applying migrations.
2. Run `npm run db:generate` and `npm run db:migrate`. `202611180022_order_return_terms` adds a nullable purchase-time terms record. New Bangladesh and US orders capture `bd-preview-v1` and `us-paypal-preview-v1`. Orders without a stored policy keep the supported historical return path. `202611180023_staging_market_fixture` adds Canada and CAD enum values. Both migrations are additive.
3. Bangladesh smoke uses mobile Bangla and English, one test COD order, private recovery, a verified claim, packing, simulated delivery and owner support. Verify post-collection balance, original address, terms and currency. Use scoped synthetic fixture cleanup. See [Bangladesh rollout and rollback](customer-account.md).
4. US staging checks its own shipping quote and receipt, market-scoped packing, shipment and PayPal payment/refund idempotency. The provider test uses signed mock callbacks. For a hosted PayPal check, configure its sandbox app and registered webhook ID. Use one sandbox purchase for delivery and another for the eligible pre-dispatch refund path. US payment availability is independent of Bangladesh COD and wallets.
5. For a planned app-origin switch, point standby to the same country data, identity/session store and signing keys for that public origin. Verify health and a known authorized receipt through that URL. Switch the country upstream only. If its authoritative data is unreachable, pause writes and serve that storefront’s availability status. Dev uses one PostgreSQL database across the markets. A real single-market database outage and independent regional failover require separate data deployments.
6. Roll back the affected country’s app origin where registered hosts are in use. On shared dev, restore the preceding compatible app image and environment through the deployment lock. Keep additive migrations, shopper IDs, signing keys and order data. Disable the fixture before reverting to images that predate Canada support. Verify health, a known private receipt and shopper sign-in. Reserve database restore for data recovery because it can discard later writes.

## Dependencies

Run `./node_modules/.bin/tsx scripts/plan-legacy-bd-accounts.ts <private-manifest>` against an approved Bangladesh export. Review duplicate, unverified and unmatched contacts before importing. Keep original IDs, order markets and source records. The planner is read-only. Historical purchase import and access for a real migrated shopper require the export and review. Native guest recovery and claims use the existing ownership workflow.

The distinct-origin fixture shares an identity and session database. Dedicated regional data sources and a standalone identity boundary, separately managed storefront origins, hosted PayPal sandbox credentials, live customer messaging and historical policy records remain deployment dependencies. The stored terms are the dev preview terms. Carrier redelivery, saved payment methods and broader payment recovery depend on local integrations. Multi-package seller settlement needs validated fulfillment and payment adapters. Optional shopping and business programs remain outside the account navigation.
