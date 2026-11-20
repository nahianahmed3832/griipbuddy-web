import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { catalogCopyHistory, saveCatalogCopySuggestion, type CopyActor } from "../../src/lib/intelligence/catalog-copy-suggestions.ts";
import { mobileOrders } from "../../src/lib/mobile/orders.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

async function resources() {
  const product = "m11-copy-" + randomUUID().slice(0, 8);
  const department = await db.department.findFirstOrThrow();
  const seller = randomUUID(), buyer = randomUUID(), stranger = randomUUID(), shop = randomUUID();
  await db.shopper.createMany({ data: [seller, buyer, stranger].map(id => ({ id, name: "Synthetic fixture", email: id + "@example.invalid" })) });
  await db.marketplaceShop.create({ data: { id: shop, ownerId: seller, slug: product, name: "Synthetic seller",
    about: "", announcement: "", published: true, marketGrants: { create: { marketId: "bd", status: "APPROVED" } },
  } });
  const variant = "v-" + product;
  await db.product.create({ data: {
    id: product, marketplaceShopId: shop, departmentId: department.id, slug: product, name: "Synthetic woven case", brand: "Fixture Studio",
    keywords: [], description: "Existing product copy", specifications: [], publication: "DRAFT", addedOn: new Date(), position: 9999,
    variants: { create: { id: variant, sku: product, options: {}, label: "Standard", position: 0,
      offers: { create: { marketId: "bd", currency: "BDT", amountMinor: 17300 } } } },
  } });
  return { product, variant, buyer, seller, stranger, shop, cleanup: async () => {
    await db.catalogCopySuggestion.deleteMany({ where: { productId: product } });
    await db.marketOffer.deleteMany({ where: { variantId: variant } });
    await db.variant.deleteMany({ where: { id: variant } });
    await db.product.deleteMany({ where: { id: product } });
    await db.marketplaceShop.deleteMany({ where: { id: shop } });
    await db.shopper.deleteMany({ where: { id: { in: [buyer, seller, stranger] } } });
  } };
}

test("configured catalog copy preserves ownership, review history, exact replay and product publication", async () => {
  const x = await resources();
  const owner = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  const admin: CopyActor = { kind: "staff", id: owner.userId };
  const seller: CopyActor = { kind: "seller", id: x.seller, shopId: x.shop };
  const wrong: CopyActor = { kind: "seller", id: x.stranger, shopId: x.shop };
  const request = { productId: x.product, operationId: randomUUID(), purpose: "summary" };
  const prior = process.env.GRIIP_M11_CATALOG_COPY;
  const priorResult = process.env.GRIIP_M11_CATALOG_COPY_RESULT;
  try {
    delete process.env.GRIIP_M11_CATALOG_COPY;
    assert.equal((await saveCatalogCopySuggestion(admin, "bd", request)).kind, "disabled");
    process.env.GRIIP_M11_CATALOG_COPY = "fixture";
    process.env.GRIIP_M11_CATALOG_COPY_RESULT = "ready";
    assert.equal((await saveCatalogCopySuggestion(wrong, "bd", request)).kind, "missing");
    assert.equal((await saveCatalogCopySuggestion(seller, "us", request)).kind, "missing");
    assert.equal((await saveCatalogCopySuggestion(admin, "us", request)).kind, "missing");
    const result = await Promise.all([saveCatalogCopySuggestion(seller, "bd", request), saveCatalogCopySuggestion(seller, "bd", request)]);
    assert.deepEqual(result[0], result[1]);
    assert.equal(result[0].kind, "recorded");
    assert.equal(result[0].record.state, "SAVED");
    assert.match(result[0].record.body ?? "", /Fixture Studio/);
    assert.equal((await saveCatalogCopySuggestion(seller, "bd", { ...request, purpose: "description" })).kind, "conflict");
    assert.equal((await saveCatalogCopySuggestion(admin, "bd", request)).kind, "conflict");
    assert.equal((await catalogCopyHistory(seller, "bd"))?.length, 1);
    assert.equal(await catalogCopyHistory(wrong, "bd"), null);
    assert.deepEqual(await catalogCopyHistory(admin, "bd"), []);
    for (const mode of ["timeout", "invalid"]) {
      process.env.GRIIP_M11_CATALOG_COPY_RESULT = mode;
      const failed = await saveCatalogCopySuggestion(admin, "bd", { ...request, operationId: randomUUID() });
      assert.equal(failed.kind, "recorded");
      assert.equal(failed.record.state, "UNAVAILABLE");
      assert.equal(failed.record.body, null);
    }
    const product = await db.product.findUniqueOrThrow({ where: { id: x.product } });
    assert.equal(product.publication, "DRAFT");
    assert.equal(product.description, "Existing product copy");
    assert.equal(product.revision, 0);
    await db.marketplaceShopMarket.update({ where: { shopId_marketId: { shopId: x.shop, marketId: "bd" } }, data: { status: "DENIED" } });
    assert.equal(await catalogCopyHistory(seller, "bd"), null);
  } finally {
    if (prior === undefined) delete process.env.GRIIP_M11_CATALOG_COPY;
    else process.env.GRIIP_M11_CATALOG_COPY = prior;
    if (priorResult === undefined) delete process.env.GRIIP_M11_CATALOG_COPY_RESULT;
    else process.env.GRIIP_M11_CATALOG_COPY_RESULT = priorResult;
    await x.cleanup();
  }
});

test("v1 mobile projections keep original order and seller ownership, market and currency", async () => {
  const x = await resources();
  const id = randomUUID(), attemptId = randomUUID();
  try {
    await db.checkoutAttempt.create({ data: { id: attemptId, requestHash: randomBytes(32).toString("hex"), guestKey: randomBytes(32).toString("hex") } });
    await db.order.create({ data: {
      id, attemptId, shopperId: x.buyer, reference: "M11-" + id, marketId: "bd", currency: "BDT", measurementTest: true,
      customerName: "Synthetic private customer", phone: "01000000000", district: "dhaka", districtLabel: "Dhaka", locality: "Fixture",
      address: "Synthetic private address", deliveryMethod: "standard", deliveryLabel: "Standard", taxLabel: "Tax",
      subtotalMinor: 17300, totalMinor: 17300, discountMinor: 0, deliveryMinor: 0, taxMinor: 0,
      items: { create: { variantId: x.variant, marketplaceShopId: x.shop, productName: "Synthetic product", sku: x.variant,
        variantName: "Standard", quantity: 1, unitPriceMinor: 17300, unitDiscountMinor: 0, lineTotalMinor: 17300, currency: "BDT" } },
    } });
    const market = { marketId: "bd", page: 1 } as const;
    const buyer = await mobileOrders(x.buyer, { audience: "customer", ...market });
    assert.equal(buyer?.orders[0].id, id);
    assert.equal(buyer?.currency, "BDT");
    assert.doesNotMatch(JSON.stringify(buyer), /private address|01000000000|shopId/);
    assert.deepEqual((await mobileOrders(x.stranger, { audience: "customer", ...market }))?.orders, []);
    assert.deepEqual((await mobileOrders(x.buyer, { audience: "customer", ...market, marketId: "us" }))?.orders, []);
    const seller = await mobileOrders(x.seller, { audience: "seller", shopId: x.shop, ...market });
    assert.equal(seller?.orders[0].id, id);
    assert.doesNotMatch(JSON.stringify(seller), /totalMinor|private address|01000000000/);
    assert.equal(await mobileOrders(x.stranger, { audience: "seller", shopId: x.shop, ...market }), null);
    assert.equal(await mobileOrders(x.seller, { audience: "seller", shopId: x.shop, ...market, marketId: "us" }), null);
  } finally {
    await db.orderItem.deleteMany({ where: { orderId: id } });
    await db.order.deleteMany({ where: { id } });
    await db.checkoutAttempt.deleteMany({ where: { id: attemptId } });
    await x.cleanup();
  }
});
