# Import the launch catalog

Start with the [CSV template](../public/templates/catalog-template.csv) and the [two-variant staging example](../public/templates/catalog-example.csv). Save as UTF-8 CSV, including the header. Each file can contain up to 150 variant rows and 256 KB.

1. Under **Staff → Catalog → Categories and collections**, find the IDs for the relevant categories and collections. Create any missing ones first.
2. In the product editor, upload approved still JPEG, PNG, or WebP images. Copy the `/media/…` paths that the uploader returns. Images are stored when uploaded. For the staging example, use the supplied `/catalog/…` paths.
3. Enter one row per SKU. Repeat the product fields for each SKU belonging to the same product. Use a stable lowercase `product_id` and a unique SKU. Keep those identifiers when a name, price, or URL changes. SKUs are normalized to uppercase.
4. Preview the CSV in **Staff → Catalog → Import CSV**. Correct errors at the reported lines and preview again. Review each New, Update, or Unchanged product before selecting **Apply import**.
5. Read the outcome before continuing. Each product and its variants are saved as a unit. If the result lists a failed product, correct it and preview again. Repeating a completed file will show Unchanged when the catalog still matches.
6. Open **Inventory** from the product list. Record verified available stock as an adjustment with a reason. New SKUs begin at zero and imports preserve all existing stock. To replace an SKU, retire it and add its replacement. Archive retired products in the editor.

| Field | What to supply |
| --- | --- |
| `product_id`, `slug`, `name`, `category_id` | Stable ID, product URL slug, approved display name, and category ID. |
| `description`, `attributes_json` | Approved description and an array such as `[{"label":"Material","value":"Cotton"}]`. Use only confirmed attributes. |
| `keywords`, `collection_ids` | Optional values separated by a vertical bar. |
| `gallery_json` | Array of `{"src":"…","alt":"…"}` entries. Supply an image and alternative text for an active product. |
| `publication`, `demo`, `featured`, `new_arrival` | `DRAFT`, `ACTIVE`, or `ARCHIVED`. Other flags take `true` or `false`. Keep incomplete records as drafts and label all samples. |
| `sku`, `options_json`, `variant_active` | SKU, object such as `{"Color":"Oat","Size":"Medium"}`, and `true` or `false`. Use `{}` for a standard variant. Active variants use the same option names and distinct combinations. |
| `variant_image`, `variant_alt` | Optional image path and alternative text for that SKU. |
| `bd_price_minor`, `bd_currency`, `bd_eligible` | Whole poisha, `BDT`, and `true` or `false`. For example, `125000` means ৳1,250.00. |
| `us_price_minor`, `us_currency`, `us_eligible` | Whole cents, `USD`, and `true` or `false`. US checkout stays closed. |

Quote a CSV cell that contains commas, quotes, or newlines. Escape each embedded double quote as two double quotes, as in the example. Leave a market’s three fields empty to disable that offer for the listed SKU. Existing SKUs omitted from a file are preserved. An import changes the listed product fields, including collection assignment, gallery, and publication state. Historical order items keep their purchase snapshots.
