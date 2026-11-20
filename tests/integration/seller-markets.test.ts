import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { catalog } from "../../src/lib/catalog/repository.ts";
import { normalizedPayPalInput, quotePayPalCheckout } from "../../src/lib/commerce/paypal-quote.ts";
import { CommerceError } from "../../src/lib/commerce/errors.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { searchShops } from "../../src/lib/marketplace/data.ts";
import { applyMarketplaceCommand, MarketplaceError } from "../../src/lib/marketplace/write.ts";
import { catalogProduct, saveProduct } from "../../src/lib/staff/catalog.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("the shared US demo checkout uses a synthetic destination before signing a quote", () => {
  const prior = {
    GRIIP_MARKETPLACE_PREVIEW: process.env.GRIIP_MARKETPLACE_PREVIEW,
    GRIIP_HYBRID_STOREFRONT: process.env.GRIIP_HYBRID_STOREFRONT,
    DATABASE_URL: process.env.DATABASE_URL,
  };
  Object.assign(process.env, { GRIIP_MARKETPLACE_PREVIEW: "1", GRIIP_HYBRID_STOREFRONT: "1",
    DATABASE_URL: "postgresql://localhost/griipbuddy_hybrid_test" });
  try {
    const input = normalizedPayPalInput({ items: [{ variantId: "v-demo", quantity: 1 }],
      customer: { country: "US", name: "Personal name", email: "personal@example.invalid", phone: "2065550100",
        addressLine1: "200 Personal Avenue", addressLine2: "Unit A", city: "Seattle", state: "WA", postalCode: "98101" } });
    assert.equal(input.customer.name, "GriipBuddy Demo Shopper");
    assert.equal(input.customer.addressLine2, undefined);
    assert.doesNotMatch(JSON.stringify(input.customer), /Personal|Seattle|98101|206555/);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("seller approval controls publication, catalog discovery, cart and quote independently per market", async () => {
  const mode = {
    GRIIP_MARKETPLACE_PREVIEW: process.env.GRIIP_MARKETPLACE_PREVIEW,
    GRIIP_HYBRID_STOREFRONT: process.env.GRIIP_HYBRID_STOREFRONT,
    MARKETPLACE_PAYPAL_US_TEST_SHIPPING_MINOR: process.env.MARKETPLACE_PAYPAL_US_TEST_SHIPPING_MINOR,
  };
  Object.assign(process.env, { GRIIP_MARKETPLACE_PREVIEW: "1", GRIIP_HYBRID_STOREFRONT: "1", MARKETPLACE_PAYPAL_US_TEST_SHIPPING_MINOR: "500" });
  const seller = randomUUID();
  const otherSeller = randomUUID();
  const shop = randomUUID();
  const otherShop = randomUUID();
  const slug = `fixture-seller-${shop}`;
  const department = await db.department.findFirstOrThrow({ select: { id: true } });
  const staff = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  const owner = { staffOwner: true, staffActorId: staff.userId };
  let productId: string | undefined;
  try {
    await db.shopper.create({ data: { id: seller, name: "Seller test", email: `${seller}@example.invalid` } });
    await db.shopper.create({ data: { id: otherSeller, name: "Second seller test", email: `${otherSeller}@example.invalid` } });
    await db.marketplaceShop.create({ data: { id: shop, ownerId: seller, slug, name: "Seller Market Fixture", about: "Synthetic fixture", announcement: "", published: true } });
    await db.marketplaceShop.create({ data: { id: otherShop, ownerId: otherSeller, slug: `fixture-${otherShop}`,
      name: "Other Seller", about: "Synthetic fixture", announcement: "", marketGrants: { create: { marketId: "bd", status: "APPROVED" } } } });
    await applyMarketplaceCommand({ action: "request-market", marketId: "bd" }, { shopperId: seller });
    await assert.rejects(applyMarketplaceCommand({ action: "staff-market-grant", shop, marketId: "bd", status: "APPROVED" },
      { shopperId: seller }), (error: unknown) => error instanceof MarketplaceError && error.status === 403);
    await assert.rejects(applyMarketplaceCommand({ action: "staff-market-grant", shop, marketId: "bd", status: "APPROVED" },
      { staffOwner: true, staffActorId: seller }), { status: 403 });
    const listing = {
      action: "draft-listing", name: "Two-market case", description: "Synthetic listing for market isolation",
      department: department.id, tags: "", sku: "MARKET-CASE", quantity: 5,
    } as const;
    await assert.rejects(applyMarketplaceCommand({ ...listing, marketPrices: { bd: 2000 } }, { shopperId: seller }), /needs approval/);
    await applyMarketplaceCommand({ action: "staff-market-grant", shop, marketId: "bd", status: "APPROVED" }, owner);
    await assert.rejects(applyMarketplaceCommand({ ...listing, marketPrices: { us: 1700 } }, { shopperId: seller }), /needs approval/);
    const drafted = await applyMarketplaceCommand({ ...listing, marketPrices: { bd: 2000 } }, { shopperId: seller });
    assert.ok("id" in drafted && typeof drafted.id === "string");
    productId = drafted.id;
    const record = await db.product.findUniqueOrThrow({ where: { id: productId }, include: { variants: true } });
    const variantId = record.variants[0].id;
    await assert.rejects(applyMarketplaceCommand({ ...listing, id: productId, marketPrices: { bd: 3000 } },
      { shopperId: otherSeller, marketId: "bd" }), { status: 404 });
    await assert.rejects(applyMarketplaceCommand({ ...listing, id: productId, marketPrices: { us: 1700 } },
      { shopperId: seller, marketId: "us" }), { status: 403 });
    await db.marketOffer.create({ data: { marketId: "us", currency: "USD", amountMinor: 1700, eligible: true, variantId } });
    await assert.rejects(applyMarketplaceCommand({ ...listing, id: productId, marketPrices: { bd: 3000 } },
      { shopperId: seller, marketId: "bd" }), { status: 403 });
    assert.equal((await db.marketOffer.findUniqueOrThrow({ where: { variantId_marketId: { variantId, marketId: "us" } } })).amountMinor, 1700);
    await db.marketOffer.delete({ where: { variantId_marketId: { variantId, marketId: "us" } } });
    await db.productImage.create({ data: { productId, src: "/editorial/hero.webp", alt: "Synthetic fixture", position: 0 } });
    const draft = await catalogProduct(db, productId);
    assert.ok(draft);
    const offer = { marketId: "us", currency: "USD", amountMinor: 1700, eligible: true } as const;
    const publish = { ...draft.product, publication: "ACTIVE" as const };
    await assert.rejects(saveProduct(staff.userId, {
      ...publish, variants: draft.product.variants.map(variant => ({ ...variant, offers: [...variant.offers, offer] })),
    }, draft.revision, "editor"), /Approve this seller for each market/);
    await saveProduct(staff.userId, publish, draft.revision, "editor");
    // A previously configured offer must remain hidden when its grant is absent.
    await db.marketOffer.create({ data: { ...offer, variantId } });
    assert.ok(await catalog.getProduct(record.slug, "bd"));
    assert.equal(await catalog.getProduct(record.slug, "us"), null);
    assert.equal((await catalog.resolveVariants([variantId], "us")).length, 0);
    assert.equal((await searchShops(slug, "us")).length, 0);
    const input = normalizedPayPalInput({
      items: [{ variantId, quantity: 1 }],
      customer: { country: "US", name: "Fixture buyer", phone: "2025550100", addressLine1: "100 Test Avenue",
        city: "Washington", state: "DC", postalCode: "20001" },
    });
    const unavailable = (error: unknown) => error instanceof CommerceError && error.detail.kind === "unavailable";
    await assert.rejects(quotePayPalCheckout(db, input), unavailable);
    await applyMarketplaceCommand({ action: "staff-market-grant", shop, marketId: "us", status: "APPROVED" }, owner);
    assert.ok(await catalog.getProduct(record.slug, "us"));
    assert.equal((await catalog.resolveVariants([variantId], "us"))[0]?.offer?.amountMinor, 1700);
    assert.equal((await quotePayPalCheckout(db, input)).lines[0]?.marketplaceShopId, shop);
    await applyMarketplaceCommand({ action: "staff-market-grant", shop, marketId: "us", status: "DENIED" }, owner);
    assert.equal(await catalog.getProduct(record.slug, "us"), null);
    assert.ok(await catalog.getProduct(record.slug, "bd"));
    await assert.rejects(quotePayPalCheckout(db, input), unavailable);
    assert.equal(await db.auditEvent.count({ where: { target: shop, action: "MARKETPLACE_GRANT_CHANGED" } }), 3);
  } finally {
    if (productId) {
      await db.marketOffer.deleteMany({ where: { variant: { productId } } });
      await db.inventory.deleteMany({ where: { variant: { productId } } });
      await db.variant.deleteMany({ where: { productId } });
      await db.product.deleteMany({ where: { id: productId } });
      await db.auditEvent.deleteMany({ where: { target: productId } });
    }
    await db.auditEvent.deleteMany({ where: { target: shop } });
    await db.marketplaceShop.deleteMany({ where: { id: { in: [shop, otherShop] } } });
    await db.shopper.deleteMany({ where: { id: { in: [seller, otherSeller] } } });
    for (const [key, value] of Object.entries(mode)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
