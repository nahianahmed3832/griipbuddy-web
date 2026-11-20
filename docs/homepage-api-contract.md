# Homepage merchandising API

The existing editable main admin owns homepage section editing under **Homepage → Merchandising sections** at `/admin/dashboard/homepage`. The Marketplace stores the draft and immutable releases in `HomepageContent` and `HomepageRelease`. The customer homepage and the published API resolve the same release, catalog and eligibility rules.

## Published storefront read

Use `GET /api/storefront/homepage?market=bd&locale=en-BD`, prefixed by the deployment base path when configured. On the protected Marketplace that is `/marketplace/api/storefront/homepage`. `lang` is accepted as the existing catalog spelling of `locale`. Send only one spelling and one value for each parameter. Omitting them uses the existing storefront market and language resolution. An unsupported market or language, duplicate parameter or preview input receives a structured `400`. An unavailable service returns `503`. The response uses `Cache-Control: private, no-store, max-age=0` and varies by `Cookie, Accept-Language`.

```json
{
  "marketId": "bd",
  "locale": "en-BD",
  "currency": "BDT",
  "homepageConfig": "home-release-24-character-identity",
  "sections": [
    {
      "id": "case-picks",
      "type": "CURATED",
      "title": "Protective cases",
      "description": null,
      "position": 3,
      "enabled": true,
      "image": null,
      "destination": null,
      "startsLocal": null,
      "endsLocal": null,
      "products": [
        {
          "id": "case-fixture",
          "slug": "protective-case",
          "name": "Protective case",
          "variantId": "v-fixture-blue",
          "image": { "src": "/marketplace/editorial/carry.webp", "alt": "Blue protective case" },
          "href": "/marketplace/products/protective-case?market=bd&variant=v-fixture-blue&browse=1&lang=en-BD",
          "amountMinor": 129900,
          "regularMinor": 159900,
          "promotionEndsAt": "2027-02-01T00:00:00.000Z"
        }
      ],
      "categories": [],
      "collections": []
    }
  ]
}
```

Values shown above are illustrative. Use server-provided URLs as returned. A category card supplies `id`, `slug`, `name`, `image` and `href`. A collection card also provides `description`; the image can be null in the schema. Prices are integer minor units in the returned currency. Use `regularMinor` for comparison only when it exceeds `amountMinor` and the returned offer represents an active promotion. `promotionEndsAt` is nullable. An empty `sections` list is valid.

The storefront sends the stable body section `id` as `sectionId` in its existing consent-gated section impressions, product impressions and product clicks. The event also carries `homepageConfig`, placement, position and market. Product events carry the parent and selected variant. The collector verifies the active section and placement in the published configuration and stores the ID in `MeasurementEvent.details`. It deduplicates impressions for the same session, market, release, section and displayed product. Distinct product clicks retain their existing nonce. Draft preview emits no measurement.

| Type | Content |
| --- | --- |
| `DEPARTMENTS` | Market-visible category cards. The configured stable ID list sets order. With no list the service chooses eligible departments. |
| `CURATED` or `FEATURED` | Curated parent products in the configured order. `FEATURED` can also use the catalog's featured set. |
| `COLLECTIONS` | Published collection cards with approved images and eligible products. `COLLECTION` is the existing single collection product row. |
| `CATEGORY_SPOTLIGHT` | One category with its image or a section image, related descendant products and a generated category destination. |
| `NEW` | Catalog-designated new products ordered by the catalog’s stored `addedOn` date. |
| `DEALS` | Products with an active promotion or a price that meets an explicitly configured market-currency budget. |
| `TILES` | An ordered section of catalog destinations with a tile layout, optional labels and responsive media. |

The API returns the eligible body content in order. It suppresses empty, disabled and inactive sections and avoids repeating a parent product across product rows. Legacy hero and personalized or evidence-based recommendation placements remain in their existing storefront contracts. Inventory and delivery coverage are checked at market level for discovery. Checkout checks the exact destination and quantity. The storefront should keep the top section and existing navigation, search, account and cart.

## Merchandising tiles

Create a `TILES` section in the editable main admin. The section uses the existing stable key, position, enabled state, schedule and market/language scope. Its `tileLayout` and `tiles` fields are required. Array order is customer-facing. Use one to twelve distinct tile keys and catalog destinations per section.

| Layout | Catalog destinations |
| --- | --- |
| `SHORTCUTS` | Categories and collections |
| `PORTRAIT` | Categories and collections |
| `SHOWCASE` | Collections |
| `DISCOVERY` | Categories, collections and products |

Each draft tile uses `key`, `kind` (`CATEGORY`, `COLLECTION` or `PRODUCT`), and `referenceId` (the stable ID of the selected catalog record). Optional `title` and `ctaLabel` replace the default destination name and action label in this scope. Compact shortcuts use the title as their visible link label. The resolver generates the destination from the current market and locale. It uses the selected variant for a product link.

Optional `image` and `mobileImage` objects contain an approved `src` and nonempty `alt`. Optional `focalPoint` and `mobileFocalPoint` objects contain numeric `x` and `y` percentages between 0 and 100, with the origin at the top left. The default desktop image comes from the catalog destination, and the mobile view can crop the desktop asset when no separate image is configured. A collection without an approved image needs a desktop override before it can be shown. Use the protected Homepage image preview for draft uploads.

The public payload and protected preview include `tileLayout` and the ordered resolved `tiles` array for each visible `TILES` section. A resolved tile has `id` (the draft key), `kind`, `title`, `ctaLabel`, `href`, `image` and optional `mobileImage`, `focalPoint` and `mobileFocalPoint`. A product tile also supplies `product: { id, variantId, amountMinor, regularMinor, promotionEndsAt }`. URLs already include the correctly scoped path. Prices are in the response currency. Legacy sections retain their current payload properties.

A category or collection tile needs a published, nonempty browse destination in the requested market. Its listing can contain browse-only catalog items. A priced product tile needs an eligible, in-stock offer in that market and uses the exact variant's price. Missing or out-of-scope media can fall back to approved catalog media. The resolver skips unavailable tiles, empty sections and products already used in a preceding product row. Uploaded editorial media takes its market and language availability from its upload scope and becomes public only when referenced by an active release.

## Editing and preview

The main admin uses its existing login, CMS permissions and operating-region selector. An enrolled central owner can edit global and selected-market scopes. Market editors must have the existing recovered CMS permissions and a native merchandising grant for that market. Scope order is built-in, global, global locale, market, then market locale. Within a scope, section position and stable key give deterministic order. A disabled override or hidden inherited key suppresses that section. An out-of-window override lets the inherited section appear. Start is inclusive and end is exclusive in the configured market timezone. The service rejects impossible or ambiguous local times. Global schedules use each affected market's wall-clock time.

The same-origin admin bridge reads permitted scopes, the current revision and draft, picker results, private preview and release history. It accepts revision-checked save, publish, restore and return-to-inheritance operations. Draft preview resolves one saved draft against a permitted market, locale and optional future local time. Uploaded draft-only assets are served from the staff bridge and excluded from the public image route until an eligible active release references them. Keep preview links inert and analytics disabled. The published route accepts no draft key or clock override.

Catalog references resolve to active products, categories and collections. Page destinations are restricted to supported internal destinations. Category spotlights derive the destination from the chosen category. Approved catalog and Homepage editorial images reuse the existing media store. Public resolution drops stale or ineligible references. The main-admin editor protects the existing top hero. Draft and release operations record actor, scope and revision. Publishing, restoring and clearing a release invalidate `/` and `/api/storefront/homepage` after commit. On Hostinger dev, reload `/marketplace` or its published API with the intended market and locale to see the release. Public cards, scheduling and prices are evaluated on each read.

## Activation and recovery

The Homepage signed channel can be enabled independently of connected catalog migration. It is limited to isolated loopback fixtures and the protected Hostinger Marketplace development profile. Configure the same secret and `GRIIP_MAIN_ADMIN_HOMEPAGE_ENABLED=1` on the two services. The editable admin requires its verified private `GRIIP_MAIN_ADMIN_HOMEPAGE_URL` and the explicit `GRIIP_MAIN_ADMIN_HOMEPAGE_INTERNATIONAL_MARKET=us` region assignment. The Marketplace requires the verified admin `GRIIP_MAIN_ADMIN_HOMEPAGE_ORIGIN` and a reviewed one-to-one `GRIIP_MAIN_ADMIN_HOMEPAGE_ACTORS` map. Keep those values in the dev service environment. Legacy homepage layout writes retire only in the connected profile. The separate recommendation policy and market grants keep their existing staff controls.

Restore a prior release or clear the scope's published override from Homepage when appropriate. Both keep the history. To reverse editor activation, disable the flag on both dev services and restore the known-good dev images if needed. Keep the release records and existing media migration in place. No new migration is required by the Homepage extension on the current candidate baseline.
