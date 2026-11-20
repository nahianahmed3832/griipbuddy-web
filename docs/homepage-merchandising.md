# Market homepage merchandising

The storefront shares one homepage resolver for its rendered page and the published read API. In the connected development profile, open **Homepage → Merchandising sections** in the existing main admin at `/admin/dashboard/homepage`. The CMS permissions, operating region, and Marketplace merchandising grant determine the scopes available to staff. Owners can edit global templates and grant individual staff editing or reporting access per market. See the [homepage API contract](homepage-api-contract.md).

The connected profile routes body layout editing, preview, and release history through the main admin. The Marketplace **Staff → Homepage** retains recommendation policy and market grant controls. The legacy profile retains its existing body editor until the connected Homepage channel is enabled.

## Draft and publication

1. Select a template scope. Use an inherited section key to override an existing body section or add a new key. Hide inherited sections explicitly when appropriate.
2. Configure the type, title, position, enablement, catalog references and approved imagery. A section may use a supported internal destination. Category spotlight derives its destination from the selected category.
3. Save the draft, then preview in the permitted market and language. The preview resolves the catalog, prices and schedule for that selection. Enter a market-local date and time to preview a scheduled campaign.
4. Publish the saved draft. Publishing and restoring create new history entries and invalidate the homepage and its read API after the transaction. Restore an earlier release from the selected scope’s history or clear that scope’s publication to return to inheritance.

The layout applies built-in defaults, the global template, the global language, the market, then the market language. A scheduled override affects the inherited section only during its active window. A disabled override hides the inherited section during that window. Global schedules run at the same local wall-clock time in each applicable market. Market schedules use the configured IANA timezone, with an inclusive start and exclusive end. The editor rejects nonexistent and ambiguous daylight-saving times. Publishing history uses the selected market timezone or UTC for global templates.

## Eligibility and evidence

The renderer uses market-catalog and seller eligibility, in-stock variants, a valid local offer in the market currency, and available delivery coverage before choosing cards. Connected stock comes from the eligible seller's routed physical pools, with each pool counted once despite overlapping delivery routes. Checkout validates the shopper’s exact destination, service and available inventory. The resolver removes repeated parent products across editorial rows and suppresses empty rows. Preview cards are inert and excluded from analytics. Uploaded draft imagery stays behind staff authorization until an active published section references it.

- **Shop by category** and **Category spotlight** use the localized catalog hierarchy and respect its market navigation visibility. Spotlight includes eligible products from primary or additional assignments anywhere in the category subtree.
- **Featured products** and **Featured collections** use stable catalog references in the configured order. Collection cards require an approved image and eligible products. Empty curated rows can use an explicit eligible fallback.
- **New arrivals** use the catalog's new-arrival designation and its recorded `addedOn` date.
- **Offers** require an actual active variant promotion. A budget row requires a market-specific minor-unit price ceiling in that market's currency. A matching variant supplies the card's image, price and link.

- **Bestsellers** require three distinct delivered, placed orders with verified online payment or COD collection in that market over the trailing 30 days. Rank by units and then distinct orders.
- **Trending** requires at least five distinct consented product-view sessions in the trailing seven days, with at least three additional sessions and 50% growth over the preceding seven days. Rank by session growth. Repeated views within a session contribute once.
- A demand-labeled row requires two eligible products with qualifying evidence. Sparse data uses the supplied curated IDs or eligible featured products with the **Curated picks** heading. If none remain, the row stays hidden. Fixture and unclassified activity are excluded from demand rankings.
- Continue browsing uses eligible recent views from the selected market and requires both shopping measurement and separate personalization permission. The existing similar-to-viewed homepage section uses a market- and viewer-scoped browser history with the same permission. For product pages, the shared service uses compatibility and catalog attributes without history.

Homepage analytics store the public layout configuration and the placement position. Historical application-defined layout labels remain readable. Unpublished previews stay separate from public measurement.

## Recommendation controls

Open **Staff → Homepage → Recommendation policy** in the desired scope. Inherit the global defaults or choose a strategy, merchandising boosts, exclusions, or curated fallbacks for that market and placement. In the connected profile, publishing a recommendation policy preserves the active layout and any pending body draft. Main-admin release history restores the selected release's complete configuration. The draft, publication and restore operations record material changes in the staff audit log.

Use **Preview recommendations** to check the resolved ranking and each product’s reason, strategy, and version. It supports anonymous, recent-intent, and repeat-purchase fixtures. Preview uses eligible products in the selected locale and currency and does not read a real shopper’s history.

Published behavioral strategies require a shopper to grant both shopping measurement and personalized recommendations under **Privacy choices**. Replay is a separate choice. Reset clears the recommendation generation. Turning personalization off also removes the behavioral placements while curated and contextual products remain. Where available, an authenticated journey can use the verified shopper’s paid or collected, delivered purchase history in the market. Buy again is restricted to expressly replenishable products with a purchase at least 14 days old. Complementary suggestions use curated compatibility, matched devices, or at least three completed same-market orders for the pair. The service suppresses known compatibility conflicts.

Recommendation results use current products and variants with local offers and stock. Results are memoized only for the current request using market, locale, and policy version. Personalized responses use private, non-persistent HTTP responses. The checkout remains authoritative for delivery to a specific address. See [the recommendation experiment plan](recommendation-experiment.md) for exposure and commerce reporting.
