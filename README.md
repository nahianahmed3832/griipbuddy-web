# GriipBuddy storefront preview

Step 5 adds sign-in and the customer account area. The local preview includes phone and verified email sign-in, simulated verification and recovery, and a design-only Google button. See the [Step 5 report](CUSTOMER_EXPERIENCE_REPORT.md) for what works in fixture and recovered API modes. The [cart and markets report](CART_AND_MARKETS_REPORT.md) and [catalog report](CATALOG_REPORT.md) cover the earlier storefront phases.

The storefront keeps the warm ivory page background (`#F7F6F2`), editorial imagery, Manrope headings and Inter body text. The plum header puts a wide, category-aware search field alongside the supplied wordmark. Compact category tiles and collection panels use the new reference's layout cues. Orange highlights the search action and selected elements.

```sh
npm ci
npx playwright install chromium
npm run lint
npm run build
npm test
npm run start -- --port 4315
```

Use Node 20.20.2 or newer and open [the local storefront](http://127.0.0.1:4315/). This mode uses synthetic fixtures. The root URL resolves to the current country or International. Open the [US storefront](http://127.0.0.1:4315/us) to try the synthetic delivery rate and coupon `PREVIEW10`. Open [customer sign-in](http://127.0.0.1:4315/us/login) and use the synthetic phone `01000000021` or email `maya@preview.invalid` with password `Preview-only-2026`.

For recovered API mode, start the isolated synthetic backend as described in `LOCAL_DEVELOPMENT_GUIDE.md` in the private recovery worktree. Start the storefront with the server-only loopback URL.

```sh
GRIIPBUDDY_CATALOG_API=http://127.0.0.1:38100/api/v1 npm run start -- --port 4316
```

The adapter accepts an explicit IPv4 loopback API URL at `/api/v1`. Product and category media from the API is eligible only when its exact HTTPS origin is in the comma-separated `GRIIPBUDDY_CATALOG_MEDIA_ORIGINS` setting. Configure only approved staging media origins. The synthetic frontend mode requires neither setting. To exercise the recovered API suite, run the guarded seed and Playwright commands in the [Step 5 report](CUSTOMER_EXPERIENCE_REPORT.md).

## Step 5 review screenshots

- [Desktop sign-in](review/step5/sign-in-desktop.webp)
- [Mobile email sign-in](review/step5/sign-in-mobile.webp)
- [Account overview](review/step5/account-desktop.webp)
- [Saved addresses](review/step5/addresses-desktop.webp)
- [Mobile order tracking](review/step5/order-mobile.webp)

## Step 4 review screenshots

- [Desktop bag drawer](review/step4/bag-drawer.webp)
- [Desktop shopping bag](review/step4/bag-desktop.webp)
- [Mobile shopping bag](review/step4/bag-mobile.webp)
- [Checkout review](review/step4/checkout-desktop.webp)
- [Market selector](review/step4/market-selector.webp)

## Step 3 review screenshots

| Screen | Desktop | Mobile |
| --- | --- | --- |
| Homepage | [Desktop](review/step3/home-desktop.webp) | [Mobile](review/step3/home-mobile.webp) |
| Catalog | [Desktop](review/step3/catalog-desktop.webp) | [Mobile](review/step3/catalog-mobile.webp) |
| Product | [Desktop](review/step3/product-desktop.webp) | [Mobile](review/step3/product-mobile.webp) |

The [Step 2 screenshots](review/) document the previous homepage.

## Artwork

The existing placeholder hero and contact sheets were generated with built-in imagegen and retained for this layout review. WebP assets are under [editorial](public/editorial) and [catalog](public/catalog). The supplied wordmark was adapted for the [header and footer](public/brand/griipbuddy-wordmark.webp), and the supplied square mark was resized for the [browser icon](src/app/icon.png). The tagline appears as the homepage headline. The product art represents the synthetic fixture catalog.

1. Use case: photorealistic-natural. Asset type: wide editorial photo for the right half of a premium contemporary fashion and accessories e-commerce homepage. Landscape approximately 3:2. Fashion editorial photograph of a stylish young adult South Asian woman with dark slicked-back hair and dark narrow sunglasses in an oversized deep espresso tailored coat, outdoors against large warm pale limestone walls in late-afternoon sun. She carries a small cobalt blue leather crossbody with sleek silver hardware in front of her, bag clearly visible, and looks over her shoulder. Shoot knees-up, body mostly in center-right, empty luminous concrete on the left, poised but candid. Slight flash texture, long shadows, modern minimalist art direction, dark chocolate, warm stone, strong cobalt pop. The image should feel like a real understated independent fashion magazine photograph. No copy, logo, graphics, lettering, watermark, frame or layout. Do not crop out the head or bag.

2. Use case: photorealistic-natural. Asset type: one six-panel editorial photo contact sheet that will be mechanically sliced into six rectangular website tiles. Output a landscape 3:2 image. A mathematically exact 3 columns by 2 rows grid, no gutters, borders, text or dividers. Image transitions exactly at 1/3 and 2/3 of width, and halfway in height; each cell is a fully independent square photograph with its subject centered and no objects crossing tile boundaries. Row 1 left: Technology, cobalt blue protective phone case angled on a brushed aluminum surface with a directional shadow. Row 1 middle: Fashion, close-up of stylish slim dark oval sunglasses on the face of a dark-haired woman in sunlight, cool minimalist portrait. Row 1 right: Clothing, sculptural folded bone cotton t-shirt and a white undershirt on a soft pale lilac studio surface. Row 2 left: Bags, compact structured espresso brown shoulder bag on warm peach backdrop in direct sun. Row 2 middle: Lifestyle, reusable matte sage water bottle and white canvas tote atop a softly lit beige bench. Row 2 right: a fashionable young adult in white cotton and navy trousers walking down pale concrete steps carrying a cobalt bag, cropped from shoulders to feet for a full bleed campaign tile. Cohesive editorial lighting, varied color fields, vibrant premium brand art direction. No typography, no printed words, no logos, no watermark. Maintain each cell independent.

3. Use case: product-mockup. Asset type: one product photography six-panel contact sheet for a synthetic demo catalog, each cell mechanically cropped separately. Wide landscape 3:2, exact 3 columns by 2 rows, no gutters or grid lines, no text, labels, people or logo. Each cell a centered single product with generous margins, same clean studio style, muted pale backgrounds with soft directional shadows and crisp materials. Top left cobalt blue protective phone case with camera cutout on pale blue. Top center black oval sunglasses on soft off-white. Top right dark espresso leather crescent-shaped shoulder bag on pale sand. Bottom left cream heavyweight cotton t-shirt folded neatly on warm gray. Bottom center terracotta matte insulated bottle on pinkish ivory. Bottom right structured ecru canvas tote with black straps on warm pale gray. Keep all six subjects distinct and entirely within their exact square cell. Premium e-commerce product photography.

4. Use case: background-extraction. Input image: the supplied GriipBuddy brand lockup is the edit target. Make one transparent PNG header wordmark from this exact mark. Remove only the warm textured paper background, and omit the small separate tagline ‘Grip your day.’ below the wordmark so the header logo stays legible at small sizes. Keep the exact orange symbol, its two circles, its bowl shape, the exact deep-plum ‘GriipBuddy’ lettering with both dotted i letters, the original spacing and orientation. Keep the original graphical proportions and flat brand color appearance. Do not redraw, stylize, add lettering or change the spelling. Horizontal mark, centered on a true transparent background with generous transparent room around every side, no other elements. Preserve crisp edges and transparent letter counters.

## Steps 6–7: isolated checkout

See the [checkout contracts](CHECKOUT_CONTRACTS.md) and [final acceptance report](FINAL_ACCEPTANCE_REPORT.md).

With Node 20.20.2 or newer, run `npm ci` and `npm run build` in this directory. Start the simulated checkout on loopback:

```sh
unset GRIIPBUDDY_CATALOG_API
export GRIIPBUDDY_CHECKOUT=synthetic
export GRIIPBUDDY_CHECKOUT_DIR="$(mktemp -d /tmp/griipbuddy-checkout.XXXXXX)"
export GRIIPBUDDY_CHECKOUT_OPERATOR_SECRET="$(openssl rand -hex 32)"
export GRIIPBUDDY_STRIPE_SIM_SECRET="$(openssl rand -hex 32)"
export GRIIPBUDDY_PAYPAL_SIM_SECRET="$(openssl rand -hex 32)"
export GRIIPBUDDY_CANONICAL_ORIGIN=http://127.0.0.1:4317
npm run start -- --port 4317
```

Use synthetic details only. Open [US storefront](http://127.0.0.1:4317/us) or [Bangladesh storefront](http://127.0.0.1:4317/bd), add an available variant to the bag, then select **Review checkout**. Quote-only and recovered API modes do not accept these order writes. For release tests, run `GRIIPBUDDY_TEST_SOURCE=release npm test` against a fresh private checkout directory. `GRIIPBUDDY_SCREENSHOTS` optionally sets a local output directory for browser screenshots. The Playwright suite allocates separate processes and loopback ports 4322–4324.

Rollback rehearsal: restart with `GRIIPBUDDY_CHECKOUT_PAUSED=1` and the same synthetic directory and secrets to block new orders while keeping existing order, callback and reconciliation access. Back up using SQLite's online backup operation into a different private directory; verify integrity, foreign keys and aggregate counts before starting the candidate against that copy. Never replace a running database or copy a WAL database as a single file during writes. To roll back the storefront binary after draining pending payments, use the approved Step 5 commit `8232a54` and retain the isolated ledger for reconciliation. There was no production schema change to roll back.

## Step 8 content and provider setup

Set `GRIIPBUDDY_CONTENT_API` to the isolated loopback recovery API ending in `/api/v1` to read the admin-managed announcement, homepage and SEO content. Media uses local storefront assets or the configured catalog media origins. Canonical URLs and the preview indexing policy stay in storefront configuration.

`src/features/checkout/provider-setup.ts` contains sandbox-only session creation for Stripe and PayPal. It expects `GRIIPBUDDY_PROVIDER_RETURN_ORIGIN`, `GRIIPBUDDY_STRIPE_TEST_SECRET`, `GRIIPBUDDY_PAYPAL_SANDBOX_CLIENT_ID`, and `GRIIPBUDDY_PAYPAL_SANDBOX_CLIENT_SECRET` at runtime. The adapters are setup code and are not wired to checkout, captures, callbacks, refunds or MongoDB reservation writers.
