# GriipBuddy Step 4 · Markets, shopping bag, and checkout review

The local branch `feature/storefront-cart` starts from approved Step 3 commit `53a4ce9`. The catalog and bag share the existing storefront design and market-aware navigation.

| Area | Result |
| --- | --- |
| Market resolution | Explicit market path, saved manual preference, trusted country header, then International. Unprefixed URLs redirect to the resolved market and retain their query. The selector saves a first-party preference cookie. |
| Market and currency | `/bd`, `/us`, and `/international` are separate storefront paths. Other active countries use their own codes and configured currencies. International uses the configured active international source, US and USD by default. If that source is missing, the fallback has no eligible products. |
| Delivery coverage | Shipping needs an explicit country and a configured rate in that country's currency. International browsing requires choosing a delivery country. The checkout estimate is unavailable when shipping is unknown. |
| Shopping bag | Responsive drawer and full page, add and remove exact variants, quantity changes, empty and loading states, market repricing, line-level issues, persistent guest state, and coupon entry. Unavailable lines remain visible for removal or a switch back to their original market. |
| Prices and stock | The quote derives prices from the current market's SKU data. It checks publication, region, country, exact variant ownership and reservation-adjusted stock, then calculates totals in currency minor units. Invalid quantities and duplicate variant identities are rejected. Missing prices and unknown stock block checkout review. |
| Checkout review | The review refreshes its estimate before simulating approval or decline. The estimate includes configured shipping and excludes tax. The simulation produces a response only and does not place an order, reserve stock, create a transaction or contact a payment provider. |
| Guest migration | A versioned browser snapshot and a shared merge function preserve product and variant identity. Authenticated cart persistence, cross-device sync, and importing browser state from the former storefront are pending. |
| Coupons | `PREVIEW10` exercises the coupon interface in the US and BD synthetic markets. The recovered validator uses domestic flat prices and CMS offer rules. The API mode exposes an explicit unavailable state until currency-aware coupon validation is defined. |
| Deployment checks | Trusted edge country detection was exercised with a synthetic header. Real edge GeoIP, the restored Atlas catalog, production delivery rates and taxes remain unverified. |

## Recovered behavior

The recovery contract in the private recovery worktree identified a client cart state slice, an add action and a persistence allowlist in the deployed storefront. The route registry has no mounted server cart endpoint. The legacy MongoDB cart namespace has no verified HTTP contract. This phase uses a browser adapter and a storefront-owned quote endpoint. The recovered product, country, currency and stock reads remain the data source in API mode.

## Local configuration

From the storefront directory, run `npm ci`, `npm run lint`, `npm run build`, and `npm test`. Start the fixture preview with `npm run start -- --port 4313`.

| Setting | Purpose |
| --- | --- |
| `GRIIPBUDDY_COUNTRY_HEADER` | Country header from a trusted proxy that strips incoming copies and sets a two-letter country code. Leave unset for ordinary loopback use. The test runner sets `x-griipbuddy-country`. |
| `GRIIPBUDDY_INTERNATIONAL_COUNTRY` | Active international catalog source for the `/international` presentation. Defaults to US. |
| `GRIIPBUDDY_SHIPPING_RATES` | Country-keyed JSON with an exact currency and a nonnegative integer rate in minor units, for example `{"US":{"currency":"USD","feeMinor":700}}`. API mode has no default coverage. Synthetic fixtures include explicit US and BD rates. |
| `GRIIPBUDDY_CATALOG_API` | Existing isolated loopback catalog endpoint, such as `http://127.0.0.1:38100/api/v1`. |

To run the recovered API tests, start the isolated synthetic backend described in `LOCAL_DEVELOPMENT_GUIDE.md` in the private recovery worktree and add the guarded catalog fixtures. The test runner supplies a synthetic BD shipping rate. The [recovered account test instructions](CUSTOMER_EXPERIENCE_REPORT.md#reproducing-verification) document the required fixture credential and backend path.

```sh
node tests/seed-catalog-api.mjs /path/to/local/recovered/backend
GRIIPBUDDY_TEST_SOURCE=api GRIIPBUDDY_CATALOG_MEDIA_ORIGINS=https://media.fixture.invalid npm test
```

## Contracts for the rebuilt backend

The internal storefront `POST /api/cart/quote` accepts `market`, `lines:[{productId,variantId,slug,quantity}]` and an optional coupon code. It returns normalized line statuses, authoritative unit and line amounts, sale and coupon discounts, shipping eligibility and an estimated total. It does not persist the quote. The simulation flag is a local preview input.

The following are contract proposals for future backend work. Endpoint names and schemas remain to be agreed.

| Operation | Required behavior |
| --- | --- |
| Merge guest bag | Require customer authentication, a guest snapshot version, exact IDs and quantities, an idempotency key and the customer's current cart revision. Return the new revision and conflicts per line. A repeated merge must not add the same quantities twice. |
| Validate an authoritative checkout quote | Accept the destination and line identities. Resolve market, currency, published SKU, quantity rules, promotions, coupon eligibility, shipping, tax and stock server-side. Return line-level errors or an expiring quote ID and a full minor-unit breakdown. |
| Confirm checkout later | Revalidate the quote against current prices, stock and destination. Use an idempotency key and make order creation and stock reservation atomic before advancing the payment flow. See `RISKS_AND_BLOCKERS.md` in the private recovery worktree for the recovered international price fallback and payment reservation races. |

## Verification

Lint, the production build, 12 Playwright tests in fixture mode, and four tests against the recovered Express API on synthetic MongoDB passed. The browser tests cover market priority, fallback, saved preference, drawer and full bag navigation, quantity changes, variant repricing, coupon rejection and application, refresh persistence, and checkout approval and decline simulations.

The API tests confirmed BDT, USD and EUR prices from stored variant records, a missing AUD price, cross-region exclusion, and 10 available units after reservations. The test quote ignored submitted totals and rejected duplicate variant identities, invalid quantities and cross-origin requests. Before and after the API suite, the synthetic orders, reservations, warehouse and global stock, transactions, movements and lots matched SHA-256 `2082d2cb2d297d1eb7da915effb109ff175f74c538d69c9832b795d59fe93b57`.

## Review

The [screenshots](README.md#step-4-review-screenshots) show the synthetic storefront on desktop and mobile. Step 5 is pending review.
