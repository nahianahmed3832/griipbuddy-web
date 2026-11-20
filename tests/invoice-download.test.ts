import assert from "node:assert/strict";
import test from "node:test";
import { markets } from "../src/config/markets.ts";
import { invoiceAttachment } from "../src/lib/commerce/invoice-download.ts";

test("invoice attachment escapes ordered content and sends a private downloadable document", async () => {
  const response = invoiceAttachment({
    audience: "seller", reference: 'Order x"\r\n<script>', date: "20 November 2026", market: markets.us, status: "Placed",
    recipient: { title: "Seller", lines: ['<b>Shop name</b>'] },
    items: [{ productName: "<script>alert(1)</script>", variantName: "Small & blue", sku: '"SKU-1"', quantity: 1, lineTotalMinor: 2500 }],
    totals: [{ label: "Shop merchandise subtotal", amountMinor: 2500 }],
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /private.*no-store/);
  assert.match(response.headers.get("content-disposition") ?? "", /^attachment; filename="griipbuddy-seller-invoice-[a-z0-9-]+\.html"$/i);
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  const body = await response.text();
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(body, /Small &amp; blue · &quot;SKU-1&quot;/);
  assert.match(body, /&lt;b&gt;Shop name&lt;\/b&gt;/);
  assert.match(body, /\$25\.00 USD/);
  assert.doesNotMatch(body, /<script>|<b>Shop name/);
});
