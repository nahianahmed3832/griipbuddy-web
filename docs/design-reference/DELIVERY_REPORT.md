# GriipBuddy storefront redesign delivery

7 November 2026 · Development preview · **PARTIALLY COMPLETE**

The redesigned journey was implemented on the existing Next.js storefront. The development deployment uses the public retail assortment for browsing and an isolated checkout simulator. The hosted preview cannot demonstrate the entire requested marketplace because several departments and commerce services have no published retail data or are unavailable in preview mode.

## Completed

| Surface | Implementation |
| --- | --- |
| Homepage and merchandising | Full-width catalog campaign using a selected published GriipBuddy product photo, a responsive department rail, scrollable New Arrivals and Best Sellers, a pair of category stories, marketplace links, Rewards entry and recent browsing. The featured camera protector falls back to another stocked catalog item where available. |
| Navigation | Market and currency selector, desktop department menus and active markers, nested mobile disclosures, predictive search, wishlist, bag, and grouped shopping and support links. |
| Categories and search | Category imagery and subcategory links, product grids, existing facets and sort options, client navigation on filter and sort submissions, bottom-sheet filters, removable facets and a browse link on empty results. Search suggestions use approved product thumbnails and preserve scoped search and recent searches. |
| Product details | Existing prices, regular prices, variants, stock, SKU, galleries and video, specifications and delivery data where published. Gallery images remain visible as whole products. The zoom dialog supports image navigation and zoom, and the quantity selector respects the active variant’s checked stock and the cart limit. Related items, reviews where enabled, wishlists, comparison, quick view and watchlists use existing services. |
| Bag and checkout | Refined drawer and full bag, line images, quantity changes and removal, separate order summary, and a bag-to-checkout step indicator. The existing quote service supplies stock, totals, eligibility and checkout simulation. |
| Customer and marketplace | Shared styling for account and order views, tracking links where accounts are enabled, and updated support entry. Discover, Deals, Coupons, Group Buy, Rewards, share, collections, comparison and watchlists retain their existing behavior. |
| Interaction and accessibility | Short route, menu, drawer, image and button motion, reduced-motion support, a loading shelf, keyboard access, focus restoration, touch controls and a sticky purchase action. |

## Retail data and fixture boundaries

- The storefront reads the existing public catalog through the established GET allowlist. It reuses product IDs and slugs, category paths, brand relationships, real product and variant photos, regular and sale prices, stock, published product descriptions, available specifications and video. No catalog records were edited.
- The Bangladesh catalog request returned 207 source product rows during the audit. The rendered Phone Cases category showed 178 matching products in the sampled session. The four published departments were Phone Cases, Screen & Camera Protectors, Tech Accessories and Combo Offer. The brand endpoint returned Redmi, Samsung, iPhone, IQOO and Honor.
- The homepage uses the genuine IQOO Z11 Turbo 2nd Gen camera protector image. The walkthrough used the iQOO Z11 Turbo Premium PU Leather Cooling Case and its published white, black and gray variants. Published catalog stock controlled purchasing and variant availability. Sale amounts and original amounts came from the variant records.
- New Arrivals and Best Sellers use the existing catalog and sale ranking. The Bangladesh coupon center reads active public offers. Media with baked-in text is reused as supplied. One combo photograph showed an older price than the structured listing, so the listing and checkout quote remain the price sources.
- Fixture products, flash campaigns, points, group tiers and test customers belong to explicitly synthetic local suites. The hosted preview uses real catalog reads and simulated shipping and payments. The local public-preview suite deliberately points at the isolated fixture API.

## Partially completed

| Area | Available now | Remaining work and dependency |
| --- | --- | --- |
| Fashion, bags and lifestyle | The shared catalog, category and product templates support these product types. Local fixtures exercise clothing and bags with variants. | The hosted public catalog supplies tech accessories. Genuine, published products, categories and photography are needed to show the broader retail assortment. |
| Editorial and promotions | Catalog-led campaign, category stories, stock-backed shelves, live sale variants, public coupons and existing CMS rendering in configured environments. | The public preview does not read the private CMS. Published, preview-safe campaign assets and content would be needed for managed promotional banners and collections on this host. |
| Accounts, orders, tracking, reviews and returns | Layouts and links work where the recovered account, order and review APIs are enabled. Isolated tests exercised sign-in, order ownership, COD and reviews. Public wishlist works on the current device. | Hosted preview disables account, order and review writes, and the review integration is not enabled there. Actual customer, review and fulfillment acceptance needs an isolated authenticated deployment with verified service data and policies. |
| Group Buy, Rewards and coupon redemption | Existing routes render their catalog or availability states. Group participation and points examples are exercised in fixture mode. Public active coupons can be browsed and saved. | Hosted preview has no live group enrollment, loyalty ledger or real coupon redemption. Those require configured campaign and eligibility services and an authoritative checkout. |
| International fulfillment and payment | Market and currency selection and market eligibility use existing logic. Checkout approval and decline are simulated. | Shipping remains an estimate in the preview. Carrier coverage, duties and service levels need authoritative destination data before broader international checkout. |
| Reference coverage | The UK and Japan English homepages, every top-level menu, representative categories and products, search, bag, checkout entry, wishlist, account entry, membership entry and service pages were explored. | Signed-in member actions, actual purchase and payment, shipment and returns were not exercised. Deep pagination and every department sub-route were outside the representative audit. See [the reference audit](SELFRIDGES_AUDIT.md). |

## Not completed

- Live checkout, payment settlement, refunds, cross-border shipment and returns were outside the development release. Verification used local simulated orders and the hosted quote simulator.
- Physical-device acceptance was outside this browser-emulation run. The viewport and interaction checks used the Playwright browser engines.
- The Selfridges checkout walkthrough ended at the sign-in or guest choice. Loyalty accrual, an authenticated wishlist, shipment and returns require an account and real transaction history. A follow-up attempt to expand the department sample timed out, so the audit lists the pages with confirmed browser evidence.

## Tests and issues resolved

- Passed the production build, ESLint with zero warnings and `tsc --noEmit` on Node 20.20.2.
- 47 automated tests passed on the deployed source revision across the fixture suite (23), simulated checkout and accessibility suite (12), recovered API suite (8), public preview suite (1) and integrated commerce suite (3). No tests were skipped on these runs. The category-image and price-format follow-ups also passed 14 focused catalog, shell and cart tests before the full final run.
- The initial checkout runner failed because the Mac default Node version could not load the SQLite binary built for Node 20. The first recovered-API run lacked the required isolated fixture configuration. Both passed with the pinned runtime and a fresh loopback MongoDB and Redis fixture. A high-concurrency fixture run hit the account test’s 30-second timeout. The complete two-worker rerun passed. A duplicate integration run shared the already-reviewed fixture and hit the expected eligibility restriction. The fresh integrated suite passed all three tests.
- Initial UI checks found an ambiguous saved-items locator, Escape focus behavior and assertions tied to the previous menu and palette. The final tests cover the new nested menu, image suggestions and quantity control. An initial image-check run reported a hydration exception while the harness modified image attributes. The repeat using read-only image decoding passed without page or console errors. Hosted WebKit then identified a separate product-price hydration mismatch. Node and WebKit chose different Bangladesh and euro formats for the same locale, so the shared formatter now uses stable English formats for BDT and EUR. The real coupon expiry hit the same runtime discrepancy and now uses a fixed English UTC display. Full-opacity route motion resolved a contrast finding during the transition. The catalog image component now retries the original approved URL when an optimizer request fails.
- Headless Chromium was denied by Selfridges. The in-app browser loaded the live pages and exercised the interactions recorded in the audit.

## GitHub and development deployment

- Repository and branch [nahianahmed3832/griipbuddy-web · feature/selfridges-storefront](https://github.com/nahianahmed3832/griipbuddy-web/tree/feature/selfridges-storefront).
- Deployed source revision [47e967fd1c8ff19b460ec86af49eb425096910fc](https://github.com/nahianahmed3832/griipbuddy-web/commit/47e967fd1c8ff19b460ec86af49eb425096910fc). The remote branch and the development container image label were verified independently. The final documentation commit contains this report and the hosted captures.
- Deployment [frontend.griipbuddy.com](https://frontend.griipbuddy.com/) returned HTTP 307 to the market route, followed by HTTP 200 with the redesigned page and the development-only banner. The release targeted the existing development storefront service. Its edge, API and admin containers matched their pre-release identities. Catalog access remained read-only. A restart briefly returned HTTP 502 on an earlier rollout before the health check passed.
- Independent hosted Chromium verification passed at 375, 390, 430, 768, 1024 and 1440 pixels with no horizontal overflow on the homepage, category, product and populated bag. The browser exercised the collection rail, navigation and mobile disclosures, predictive and empty search, sort, filters, variants, zoom, wishlist, quantity, removal, checkout entry, simulated approval and decline, marketplace routes and reduced motion. Checked images decoded and the final walkthrough recorded zero page or console errors.
- Hosted Firefox and WebKit each passed six routes at 390 and 1440 pixels, including the product price and coupon expiry, without page exceptions. Additional hosted Chromium checks passed for Australia market selection, ordinary motion, search when suggestions returned a simulated 503, and loading the approved original photo after a simulated optimizer failure.
- The dedicated `caffeinate -dimsu` process was checked before the intensive work and remained active through implementation, testing, releases and report preparation.

## Before and after

The before captures show the previous hosted storefront. The after captures show the final hosted release. The bag captures contain different published catalog items.

| Page | Before | After |
| --- | --- | --- |
| Homepage | [Desktop](before-home.jpg) | [Desktop](after-home.jpg) |
| Category | [Phone Cases](before-category.jpg) | [Phone Cases](after-category.jpg) |
| Product | [Cooling Case](before-product.jpg) | [Cooling Case](after-product.jpg) |
| Bag | [Populated bag](before-cart.jpg) | [Populated bag](after-cart.jpg) |
| Mobile | [Homepage at 390px](before-mobile.jpg) | [Homepage](after-mobile.jpg), [product](after-mobile-product.jpg), [filters](after-mobile-filters.jpg) |

## Final assessment

**PARTIALLY COMPLETE.** The redesigned development storefront is pushed, deployed and verified with genuine retail data. The remaining scope depends on published assortment and campaign content, authenticated development services and live commerce acceptance as listed above.
