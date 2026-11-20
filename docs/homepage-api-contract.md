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

The API returns the eligible body content in order. It suppresses empty, disabled and inactive sections and avoids repeating a parent product across product rows. Legacy hero and personalized or evidence-based recommendation placements remain in their existing storefront contracts. Inventory and delivery coverage are checked at market level for discovery. Checkout checks the exact destination and quantity. The storefront should keep the top section and existing navigation, search, account and cart.

## Editing and preview

The main admin uses its existing login, CMS permissions and operating-region selector. An enrolled central owner can edit global and selected-market scopes. Market editors must have the existing recovered CMS permissions and a native merchandising grant for that market. Scope order is built-in, global, global locale, market, then market locale. Within a scope, section position and stable key give deterministic order. A disabled override or hidden inherited key suppresses that section. An out-of-window override lets the inherited section appear. Start is inclusive and end is exclusive in the configured market timezone. The service rejects impossible or ambiguous local times. Global schedules use each affected market's wall-clock time.

The same-origin admin bridge reads permitted scopes, the current revision and draft, picker results, private preview and release history. It accepts revision-checked save, publish, restore and return-to-inheritance operations. Draft preview resolves one saved draft against a permitted market, locale and optional future local time. Uploaded draft-only assets are served from the staff bridge and excluded from the public image route until an eligible active release references them. Keep preview links inert and analytics disabled. The published route accepts no draft key or clock override.

Catalog references resolve to active products, categories and collections. Page destinations are restricted to supported internal destinations. Category spotlights derive the destination from the chosen category. Approved catalog and Homepage editorial images reuse the existing media store. Public resolution drops stale or ineligible references. The main-admin editor protects the existing top hero. Draft and release operations record actor, scope and revision. Publishing, restoring and clearing a release invalidate the homepage and published read paths after commit. Public cards, scheduling and prices are evaluated on each read.
