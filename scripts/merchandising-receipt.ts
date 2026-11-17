import assert from "node:assert/strict";
import { catalog } from "../src/lib/catalog/repository.ts";
import { getDb } from "../src/lib/db/client.ts";
import { stagingDatabase } from "../src/lib/db/local.ts";
import { candidateView, pricing, readiness } from "../src/lib/staff/merchandising.ts";

async function snapshot() {
  assert.ok(stagingDatabase(), "Use only the dedicated staging catalog.");
  const prefix = "merch-" + process.argv[2] + "-";
  assert.match(prefix, /^merch-[a-z0-9]{4,18}-$/);
  const db = getDb();
  const rows = await db.merchandisingCandidate.findMany({ where: { productId: { startsWith: prefix } }, orderBy: { productId: "asc" } });
  assert.equal(rows.length, 5);
  const products = [];
  for (const row of rows) {
    const view = candidateView(row);
    assert.equal(view.draft.product.demo, true);
    const checks = await readiness(db, view);
    const variants = await db.variant.findMany({ where: { productId: view.productId }, include: { inventory: true, offers: true } });
    const publicProduct = await catalog.getProduct(view.draft.product.slug, "bd");
    products.push({
      candidate: view.id, productId: view.productId, name: view.draft.product.name, sourceVersion: view.sourceVersion,
      revision: view.revision, review: view.decision, approvedMarkets: view.approval?.markets ?? [], duplicateRows: view.source.duplicateRows,
      conflicts: view.source.conflicts.length, gaps: checks.global, marketChecks: checks.markets.map(({ market, ready, marketGaps }) => ({ market, ready, marketGaps })),
      publication: checks.current?.publication ?? "Candidate only",
      variants: variants.map((variant) => ({ sku: variant.sku, stock: variant.inventory?.available ?? 0,
        offers: variant.offers.map(({ marketId, amountMinor, currency, eligible }) => ({ marketId, amountMinor, currency, eligible })) })),
      publiclyVisibleInStaging: Boolean(publicProduct),
      pricing: pricing(view, "bd").map(({ sku, units, contribution, unknown }) => ({ sku, units, contribution, unknown })),
      launch: view.launch.map(({ market, revision, method, text }) => ({ market, revision, method, text })),
    });
  }
  const mug = products.find((row) => row.productId.endsWith("-mug"));
  const tote = products.find((row) => row.productId.endsWith("-tote"));
  assert.equal(mug?.publication, "ACTIVE");
  assert.equal(mug?.variants[0]?.stock, 0);
  assert.equal(mug?.pricing[0]?.contribution, 149000);
  assert.equal(mug?.launch[0]?.text.destination, "/products/" + mug?.productId);
  assert.equal(tote?.publication, "DRAFT");
  assert.equal(tote?.variants.length, 2);
  assert.equal(tote?.publiclyVisibleInStaging, false);
  console.log(JSON.stringify({ environment: "Hostinger storefront staging", products }, null, 2));
}

snapshot().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => getDb().$disconnect());
