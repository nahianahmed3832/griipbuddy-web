# GriipBuddy Global Storefront Acceptance

7 November 2026

This report records the original global-storefront baseline at `6774f968`. The hosted storefront subsequently switched to the read-only retail catalog and received a new design pass. See the [preview configuration](README.md#step-10-local-verification).

The global storefront is available in the local `feature/global-storefront` branch, based on Step 10 revision `45a94fc2`. The marketplace design, catalog discovery, and customer journey are ready for local review. Features that depend on a commerce service have either a clearly labeled development preview or an availability state.

## Completed and incomplete features

| Area | Implemented and exercised | Incomplete or dependent on data |
| --- | --- | --- |
| Design and navigation | Original editorial hero, shared color and typography tokens, responsive search and category menus, seven sample departments, desktop utilities, mobile bottom navigation, and a support footer. Existing admin-managed campaign and SEO content remain supported. | Live photography and campaigns need approved assets and copy. |
| Homepage and discovery | Discover, Deals, Group Buy, and Coupons entry points. Market-aware new arrivals, best sellers, trending labels, CMS featured products and banners, brand browsing, recently viewed products, watchlist, and an editorial bag campaign. | Personalized ranking and purchase-based recommendation data. Verified customer review media remains on product pages. |
| Catalog | Nested categories, scoped suggestions, price, color, size, stock and brand filters, variant-aware sale browsing, quick view, three-item comparison, product galleries and zoom, and related products. The legacy API falls back to paged batches above 1,500 source rows. | Full-catalog search relevance, global facets, and exact market-filtered counts at scale require upstream support. The batch mode filters eligible items within each batch. |
| Social shopping | Development-only Group Buy with start and end states, countdown, two tiers, join and leave, progress on the current device, and shareable sample links. Product sharing and existing curated add-ons work through storefront links and bag controls. | Live group memberships, referral attribution, bundles with shared pricing, mix-and-match discount rules, and buy-more-save-more offers. |
| Offers and coupons | Sale prices come from catalog variants. Bangladesh coupon discovery reads public active offers and displays terms from the legacy API. Saved codes are scoped to the market. Synthetic flash and coupon examples require explicit fixture mode. | Real checkout redemption, targeted offers, and authoritative flash-sale schedules and quotas. The existing checkout quote applies the synthetic coupon in the fixture catalog. |
| Customer engagement | Existing wishlist and account preferences, clearable browsing history, market-scoped comparison and watchlists, and named collections stored on the device. Rewards shows a labeled points and tier preview in fixture mode. | Loyalty ledger, redemptions, account sync for new browser lists, and automated price-drop and restock notifications. |
| Cross-border | Market and currency selection, price eligibility, delivery details with optional dispatch, customs and consolidation fields, and the existing order tracking timeline and return screens. | Verified shipping coverage, delivery estimates by destination, customs and duty amounts, dispatch origin, and consolidation require authoritative market and shipment data. |
| Checkout and accounts | Existing drawer and full bag, quotes, fixture coupon application, guest and signed-in simulated checkout, COD, manual advance, PayPal and Stripe options where configured, saved addresses, order history, tracking, and fixture return requests. Recovered account and checkout integration tests passed locally. | Provider settlement and refunds, unrestricted international checkout, and live returns policy and eligibility are release gates. The regional payment interface retains the existing supported methods. |
| Safety and SEO | Explicit `GRIIPBUDDY_FIXTURES=1` switch, private preview indexing policy, canonical URLs, sitemap entries, and market-scoped API boundaries. The production build uses a safe empty catalog when neither a source nor the fixture switch is configured. | Search-engine indexing and live commerce acceptance remain outside the local release. |

## Verification

- Node 20.20.2, `npm run lint`, and `npm run build`.
- All 45 Playwright tests passed across the fixture suite (21), simulated checkout suite (12), recovered API suite (8), public preview suite (1), and integrated order and review suite (3).
- Chromium route audit covers desktop, tablet, and mobile. Firefox and WebKit each passed 39 route and viewport checks at 1440, 834, and 390 pixels. Representative WCAG axe checks cover catalog, checkout, and the new shopping pages. Physical devices and live providers remain unverified.
- An isolated upstream simulation declared 1,601 product rows to exercise the transition to batch 2. A separate default-mode run checked that sample products, coupons, group counters, and campaign timers stay hidden without the fixture switch.

## Local review

Use the local checkout and Node 20.20.2. The default preview browses synthetic data and supports cart quotes. The README has the extra environment settings for a disposable simulated checkout ledger.

```sh
npm run build
GRIIPBUDDY_FIXTURES=1 npm run start -- --port 4318
```

Open [local storefront](http://127.0.0.1:4318/us). The existing Mac sleep prevention process remains active.

## Screenshot index

- [Desktop home](review/global-storefront/home-desktop.jpg), [mobile home](review/global-storefront/home-mobile.jpg), [tablet catalog](review/global-storefront/catalog-tablet.jpg), and [mobile product](review/global-storefront/product-mobile.jpg)
- [Quick view](review/global-storefront/quick-view-desktop.jpg) and [comparison](review/global-storefront/comparison-desktop.jpg)
- [Deals](review/global-storefront/deals-desktop.jpg), [Group Buy](review/global-storefront/group-buy-tablet.jpg), [coupon center](review/global-storefront/coupons-mobile.jpg), and [rewards](review/global-storefront/rewards-desktop.jpg)
- [Simulated checkout](review/global-storefront/checkout-desktop.jpg) and [sample account](review/global-storefront/account-desktop.jpg)

## Design references and generated assets

The brief’s reference images informed the editorial department tiles, group progress, coupon cards, and rewards layout. Marketplace reference patterns included themed and timed promotion entries, fashion collection filters, continued discovery from browsing history, and parcel consolidation as a market-dependent service. [Temu featured sections](https://www.temu.com/pt-en/support/c3/understanding-featured-sections-on-temu-f-58-s-8282.html), [SHEIN Trends](https://us.shein.com/trends/SHEIN-Trends-sc-00679470.html), [Amazon homepage discovery](https://www.aboutamazon.com/news/retail/amazon-homepage-redesign-features), [Alibaba Group on AliExpress Choice](https://data.alibabagroup.com/ecms-files/1532295521/3786c801-0efd-406a-a8a8-3c6934905558/Alibaba%20Group%20Announces%20June%20Quarter%202023%20Results.pdf).

The built-in image generator produced the three new images, optimized to WebP for the storefront. The lamp and pouch are synthetic catalog assets.

The generation prompts are recorded below.

> Create an original luxury-meets-accessible ecommerce editorial campaign photo, no text, no logos, landscape 3:2. Used as the right-hand photography of a modern GriipBuddy web storefront hero. Art direction: warm vivid burnt orange / tangerine seamless studio cyclorama, bright direct late-afternoon light creating sculptural shadows. Premium sculptural product still-life at a 3/4 angle: an ivory pair of over-ear headphones over a softly structured cobalt-blue nylon crossbody bag, a cream ribbed mini table lamp with a domed shade and tangerine tinted contemporary sunglasses alongside, on stepped warm terracotta plinths. Objects overlap lightly in a single large centered composition and fit fully inside the middle 82 percent of the frame. Warm cream highlights, material texture, subtle photographic grain, editorial magazine realism, clean playful color, strong art direction. No people, letters, labels, frames, mockups, ecommerce UI, borders or collages. [Marketplace hero](public/editorial/marketplace-edit.webp)

> Square ecommerce catalog photo for a synthetic GriipBuddy development listing. One cream compact ribbed ceramic mushroom table lamp with a warm ivory dome shade and matte cream cylindrical ridged base, centered on warm pale peach seamless studio surface, gently directional sunny light, dimensional shadow, minimal, tactile editorial product photo, single entire object fully visible with generous room around it, color palette warm terracotta and cream, no text, logos, people, cords, set dressing, labels, or borders. [Sample Dune Table Lamp](public/catalog/dune-lamp.webp)

> Square ecommerce catalog photo for a synthetic GriipBuddy development listing. A single warm rose pink recycled nylon zippered vanity pouch, modest rectangular softly padded silhouette, neat matching zipper, centered on a muted lilac seamless studio surface, clean direct warm directional sun, tactile real nylon weave, crisp shadows, modern editorial product photography, entire object fully visible, no cosmetics, hands, branding, text, labels or borders. [Sample vanity pouch](public/catalog/vanity-pouch.webp)

## Hosted sandbox receipt

The repository's post-commit hook briefly replaced the storefront in the isolated Hostinger build sandbox with `eec91869` before the release hook was identified. A subsequent check found that the pre-hook image, `45a94fc2`, was already active and passed the sandbox HTTPS content check. Later commits used `GRIIPBUDDY_SKIP_DEV_DEPLOY=1`. The hook targeted the sandbox storefront service. Backend, admin, and production data were outside this change.
