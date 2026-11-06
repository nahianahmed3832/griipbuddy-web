# GriipBuddy Step 3 · Catalog and product experience

Local branch `feature/storefront-catalog`, based on approved homepage commit `c8e1fd7`. The review uses the existing photography, a plum masthead with a wider search field, and compact category and collection panels inspired by the supplied reference. The page background remains `#F7F6F2`.

| Area | Status | Evidence |
| --- | --- | --- |
| Category, subcategory and collection pages | Complete locally | Published category hierarchy to four levels, breadcrumb links, scoped filters, pagination, and canonical slug paths. The recovered API suite traverses a four-level tree and verifies the product's original category references. |
| Product lists and search | Complete locally | Responsive cards, URL-based category, brand, price, size, color and stock filters, and relevance, newest, popular and price sorting. The same variant satisfies size, color and price filters. Search suggestions use the active market and optional category, and support arrow-key selection. |
| Product details | Complete locally | Server-rendered title and initial variant. Selecting a real combination updates the shareable URL, images, SKU, price and stock. The gallery supports thumbnails and a keyboard-dismissable zoom dialog. Material and other attributes come from the variant, and product specifications come from the product. |
| Countries and promotions | Verified against the recovered API on synthetic MongoDB | Active countries, region and channel checks, original product and variant IDs and SKUs, BDT and explicit USD/EUR pricing, sale prices, an AUD case without a price, and unpublished, POS-only and out-of-region records. The tests also verify that market changes clear price limits when currency changes. |
| Availability | Verified against the recovered API on synthetic MongoDB | A fixture with 12 units and a reservation of 2 shows 10 available. A separate fixture with zero returns Out of Stock. Unknown stock stays unknown. The storefront uses the existing stock endpoint. |
| Wishlist and discovery | Complete locally | Wishlist and recently viewed products persist in the browser and resolve again for the current market. Related items use the existing category, recommendations use eligible catalog records, and Trending uses existing tags or labels. Best Sellers uses the recovered sales ranking. |
| Actual restored catalog and media | Unverified | API-mode tests use the recovered Express app and a local synthetic replica set. The restricted Atlas copy, its catalog volume, and its media origins were outside this run. Media reference preservation and allowlisting were tested with intercepted synthetic URLs. |
| Large listings and stock filter coverage | Bounded in this preview | Catalog scans are capped at 1,500 products per requested region or category scope. A stock filter requests at most 240 matching variants, and asks for narrower filters above that limit. The listing card checks up to eight priced variants unless it finds stock sooner. Its badge is withheld when status is unknown. Product detail checks the selected variant directly. |
| Account sync and checkout | Later phases | Wishlist and history use local browser storage. Account, bag and policy routes remain previews. Order, payment and inventory writes are outside Step 3. |

## Recovered contract

The [read-only adapter](src/features/catalog/api.ts) uses GET routes under `/api/v1` for products, product slugs, top sellers, published categories, subcategories, countries, brands and variant stock. The storefront verifies publication, website channel, region and active-country membership before exposing a product. Domestic BDT uses the flat variant price fields. International products require an explicit price in the selected currency. The recovered list's price range uses flat regular prices and its stock and attribute filters are not wired in the service. The adapter filters returned records using their eligible variant prices and uses `/stocks/:product/:variant` for availability. It sends no database credentials to the browser.

The preview retains local image optimization and lazy loading. Approved remote media keeps its source URL and loads in the browser. The product and category pages use slug URLs and page-specific metadata. The local preview is excluded from indexing.

## Verification

Production build and lint passed. Playwright passed eight Chromium fixture tests and three API-mode tests against the recovered Express app and synthetic MongoDB. The tests cover desktop, tablet and mobile layouts, the narrow mobile header and filter panel, navigation, search, market switches, sorting and filters, zoom, variant changes, stock, saved items and recent products. Production and the existing admin were outside the test run.

To reproduce the API checks, start the backend's isolated synthetic runner on port 38100. From the storefront directory, pass the path to that local backend's installed dependencies to the guarded seed script. It verifies the loopback replica, fixture namespace and original fixture markers before adding test cases.

```sh
node tests/seed-catalog-api.mjs /path/to/local/recovered/backend
GRIIPBUDDY_TEST_SOURCE=api GRIIPBUDDY_CATALOG_MEDIA_ORIGINS=https://media.fixture.invalid npm test
```

The [review screenshots](README.md#step-3-review-screenshots) show the synthetic storefront on desktop and mobile. Step 4 is pending review.
