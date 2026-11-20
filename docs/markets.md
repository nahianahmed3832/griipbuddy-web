# Operating markets

One Next.js storefront resolves the operating market for a request and uses it for catalog, pricing, inventory, checkout, merchandising and measurement. The market registry provides stable IDs and territory and currency codes. The runtime manifest controls how the registered markets operate. The recovered Express commerce service retains authority for any checkout it accepts.

## Runtime configuration

| Field | Role |
| --- | --- |
| Market ID, territory, currency | Stable storefront and PostgreSQL keys. Adding a new ID or currency requires a registry change and a Prisma enum migration. |
| `status` | `planned` stays out of customer selection. `staging` can use configured sandbox adapters in an isolated environment. `active` requires production adapter declarations. `paused` supports browsing while checkout stays closed. |
| `languages`, `defaultLocale`, `timeZone`, `reportingCalendar` | Supported language tags, default locale, IANA business timezone and reporting week start. The product price and delivery destination remain tied to the operating market. |
| `revision`, `pricing` | Commercial configuration revision, local price-list label, tax treatment and minor-unit rounding. The saved market offer supplies the actual variant price. The checkout quote uses a validated tax policy or configured provider quote. |
| `checkoutAuthority`, `address`, `delivery` | Allowed order authority, address schema and delivery source. Staff configure supported delivery areas, methods, charges and COD eligibility in Market settings when the native policy supplies them. |
| `payments`, `fulfillment`, `returns` | Adapter declarations and evidence environment. Each adapter enforces its supported address and currency contract. Local provider credentials and release gates control actual availability. |
| `catalog` | Eligible local offers, approved seller grants and inventory mode. `market-locations` uses only locations assigned to the selected market and seller. `shared-legacy` exists for earlier sandbox fixtures. |
| `privacy`, `analytics` | Opt-in measurement and Global Privacy Control. First-party collection and optional Clarity remain configurable by market. |

Set `GRIIP_DEFAULT_MARKET` to a browsable registered ID when the deployment needs a different default. Set `GRIIP_MARKET_CONFIGURATION` to an optional JSON object keyed by market ID. Each entry overrides the relevant outer fields as a unit. Nested objects and adapter arrays should include all their fields. Invalid IDs, incompatible adapters and incomplete operating definitions fail validation. In production, both markets default to paused until configured explicitly.

For example, this override gives a staging review explicit per-market inventory locations while retaining the existing sandbox adapter declarations:

```json
{
  "bd": {
    "revision": 2,
    "catalog": { "eligibility": "market-offer", "sellerPermission": "market-grant", "inventory": "market-locations" }
  },
  "us": {
    "revision": 2,
    "catalog": { "eligibility": "market-offer", "sellerPermission": "market-grant", "inventory": "market-locations" }
  }
}
```

Increase the revision when changing commercial terms. Store provider credentials in the deployment’s runtime secret store. A manifest setting supplies an adapter declaration. Checkout additionally checks operating environment, configured credentials where required, released order intake, local prices, delivery and available stock.

## Selection and scope

- Use the storefront’s shopping preferences or open a shareable link such as `/?market=bd` or `/?market=us`. The selected market persists in the browser. A supported `lang` query can select a language for that market. The storefront falls back to its supported language list and then its default locale.
- Only the server proxy stamps the downstream browsing context. It strips incoming context headers and excludes prefetch requests from preference writes. Market-specific page responses use private, uncached delivery. Product media URLs carry the market scope.
- Search, product detail, cart resolution and merchandising read eligible offers and seller grants for the selected market. A shared cart retains a shopper’s saved variant references across market changes. The storefront resolves price, eligibility and stock again for the selected destination.
- A browse selection gives shoppers a regional view. Checkout independently validates the destination against the chosen market and its payment and delivery adapters. Native orders store their market, original currency and commercial configuration snapshot.
- Merchandising and reporting permissions use separate fields in `StaffMarketAccess`. Packing staff require the operations grant for each market and may read or advance fulfillment only within that scope. Owners retain central access. The migration grants historical packers access to the original order queue. New packers require explicit assignments through `staff:create -- … --markets=bd,us`.

The supplied Bangladesh fixture uses BDT, English (Bangladesh), Asia/Dhaka, district-based delivery and COD, with an optional SSLCOMMERZ sandbox. The United States fixture uses USD, English (United States), America/New_York, postal and state validation, an isolated PayPal rate and optional PayPal sandbox capture. Both markets use the shared storefront and workflow interfaces. [QA review and configuration](market-review.md)
