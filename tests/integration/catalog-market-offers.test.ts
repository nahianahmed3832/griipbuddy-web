import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import "../../scripts/load-env.ts";
import { markets } from "../../src/config/markets.ts";
import type { CommercialActor } from "../../src/lib/commerce/commercial-access.ts";
import { readConnectedOffer, saveConnectedOffer } from "../../src/lib/commerce/market-offers.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { storeShop } from "../../src/lib/marketplace/constants.ts";
import { setWorkspaceProductPublication } from "../../src/lib/staff/product-publication.ts";
import { listProductWorkspace } from "../../src/lib/staff/product-workspace.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

async function fixture(t: TestContext) {
  const prefix = `stage4-offer-${randomUUID().slice(0, 8)}`;
  const variantId = `v-${prefix}`;
  const owner = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true }, select: { userId: true } });
  const staff: CommercialActor = { kind: "staff", id: owner.userId };
  const marketAdmin: CommercialActor = { kind: "staff", id: `${prefix}-market-admin` };
  const ops: CommercialActor = { kind: "staff", id: `${prefix}-ops` };
  const seller: CommercialActor = { kind: "seller", id: `${prefix}-seller` };
  const stranger: CommercialActor = { kind: "seller", id: `${prefix}-stranger` };
  const sellerId = randomUUID();
  const [root, category, leaf] = ["root", "category", "leaf"].map(suffix => `${prefix}-${suffix}`);
  const env = {
    GRIIP_MARKETPLACE_PREVIEW: process.env.GRIIP_MARKETPLACE_PREVIEW,
    GRIIP_FIRST_PARTY_STOREFRONT: process.env.GRIIP_FIRST_PARTY_STOREFRONT,
    GRIIP_HYBRID_STOREFRONT: process.env.GRIIP_HYBRID_STOREFRONT,
  };
  Object.assign(process.env, { GRIIP_MARKETPLACE_PREVIEW: "1", GRIIP_FIRST_PARTY_STOREFRONT: "0", GRIIP_HYBRID_STOREFRONT: "0" });
  t.after(async () => {
    try {
      await db.auditEvent.deleteMany({ where: { target: { in: [variantId, prefix] } } });
      await db.marketOffer.deleteMany({ where: { variantId } });
      await db.marketOfferIdentity.deleteMany({ where: { variantId } });
      await db.variant.deleteMany({ where: { id: variantId } });
      await db.product.deleteMany({ where: { id: prefix } });
      for (const id of [leaf, category, root]) await db.department.deleteMany({ where: { id } });
      await db.marketplaceShop.deleteMany({ where: { id: sellerId } });
      await db.shopper.deleteMany({ where: { id: { in: [seller.id, stranger.id] } } });
      await db.user.deleteMany({ where: { id: { in: [marketAdmin.id, ops.id] } } });
    } finally {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  const image = { imageSrc: "/editorial/hero.webp", imageAlt: "Fixture", position: 1 };
  await db.department.create({ data: { id: root, slug: root, name: "Tech", shortName: "Tech", description: "", kind: "DEPARTMENT", ...image } });
  await db.department.create({ data: { id: category, slug: category, name: "Props", shortName: "Props", description: "", kind: "CATEGORY", parentId: root, ...image } });
  await db.department.create({ data: { id: leaf, slug: leaf, name: "Fixtures", shortName: "Fixtures", description: "", kind: "SUBCATEGORY", parentId: category, ...image } });
  await db.product.create({
    data: {
      id: prefix, slug: prefix, departmentId: leaf, name: "Offer fixture", description: "One shared catalog product.",
      specifications: [], keywords: [], addedOn: new Date(), position: 0, foundation: true, publication: "ACTIVE",
      variants: { create: { id: variantId, sku: prefix.toUpperCase(), options: {}, label: "Standard", position: 0,
        optionSignature: "[]", isDefault: true } },
    },
  });
  await db.user.create({
    data: {
      id: marketAdmin.id, name: "Fixture market admin", email: `${marketAdmin.id}@example.invalid`,
      staff: { create: { role: "PACKER", marketGrants: { create: { marketId: "bd", commercial: true } } } },
    },
  });
  await db.user.create({
    data: {
      id: ops.id, name: "Fixture packer", email: `${ops.id}@example.invalid`,
      staff: { create: { role: "PACKER", marketGrants: { create: { marketId: "bd", operations: true } } } },
    },
  });
  await db.shopper.createMany({ data: [seller, stranger].map(actor => ({ id: actor.id, name: "Fixture shopper", email: `${actor.id}@example.invalid` })) });
  await db.marketplaceShop.create({
    data: {
      id: sellerId, ownerId: seller.id, slug: `${prefix}-shop`, name: "Scoped fixture seller", about: "", announcement: "", published: true,
      marketGrants: { create: { marketId: "bd", status: "APPROVED" } },
    },
  });
  const bd = { variantId, marketId: "bd", sellerId: storeShop.id, amountMinor: 189_900, expectedRevision: null, publication: "ACTIVE", eligible: true } as const;
  const us = { ...bd, marketId: "us", amountMinor: 2499 } as const;
  return { staff, marketAdmin, ops, seller, stranger, sellerId, productId: prefix, variantId, bd, us };
}

test("one current offer per market has its exact regional prices, sale window and browse state", async t => {
  const { staff, marketAdmin, variantId, bd, us } = await fixture(t);
  const sale = { salePriceMinor: 149_950, saleStartsAt: "2026-10-04T09:00:00+06:00", saleEndsAt: "2026-10-05T09:00:00+06:00" };
  await assert.rejects(saveConnectedOffer(staff, { ...bd, currency: "USD" }), /selected market’s currency/);
  await assert.rejects(saveConnectedOffer(staff, { ...bd, amountMinor: 12.34 }), /int|invalid/i);
  await assert.rejects(saveConnectedOffer(staff, { ...bd, salePriceMinor: 12 }), /ordered start and end/);
  const race = await Promise.allSettled([saveConnectedOffer(marketAdmin, { ...bd, ...sale }), saveConnectedOffer(staff, { ...bd, ...sale })]);
  assert.equal(race.filter(result => result.status === "fulfilled").length, 1);
  assert.match(String(race.find(result => result.status === "rejected")?.reason), /offer changed/i);
  const usd = await saveConnectedOffer(staff, us);
  const bdBefore = await readConnectedOffer(variantId, "bd", db, new Date("2026-10-04T02:59:59.999Z"));
  const bdSale = await readConnectedOffer(variantId, "bd", db, new Date("2026-10-04T03:00:00Z"));
  const bdAfter = await readConnectedOffer(variantId, "bd", db, new Date("2026-10-05T03:00:00Z"));
  const usOffer = await readConnectedOffer(variantId, "us", db, new Date("2026-10-04T03:00:00Z"));
  assert.ok(bdBefore && bdSale && bdAfter && usOffer);
  assert.equal(bdBefore.amountMinor, 189_900);
  assert.equal(bdSale.amountMinor, 149_950);
  assert.equal(bdSale.currency, "BDT");
  assert.equal(bdSale.minorDigits, markets.bd.minorDigits);
  assert.equal(bdAfter.amountMinor, 189_900);
  assert.deepEqual(usOffer, { id: usd.id, variantId, marketId: "us", sellerId: storeShop.id, currency: "USD",
    minorDigits: markets.us.minorDigits, amountMinor: 2499, regularMinor: 2499, revision: 0, eligible: true });
  assert.notEqual(bdSale.id, usOffer.id);
  const disabled = await saveConnectedOffer(marketAdmin, { ...bd, expectedRevision: bdSale.revision, eligible: false });
  assert.equal((await readConnectedOffer(variantId, "bd", db))?.eligible, false);
  assert.equal(disabled.id, bdSale.id);
  await saveConnectedOffer(staff, { ...bd, publication: "DRAFT", expectedRevision: disabled.revision, eligible: false });
  assert.equal(await readConnectedOffer(variantId, "bd", db), null);
  assert.equal((await readConnectedOffer(variantId, "us", db))?.id, usd.id);
  assert.equal(await db.marketOffer.count({ where: { variantId } }), 2);
});

test("only assigned commercial actors can edit offers and seller replacement preserves the retired identity", async t => {
  const { staff, marketAdmin, ops, seller, stranger, sellerId, productId, variantId, bd, us } = await fixture(t);
  await assert.rejects(saveConnectedOffer(marketAdmin, us), /commercial permission/);
  await assert.rejects(saveConnectedOffer(ops, bd), /commercial permission/);
  await assert.rejects(saveConnectedOffer(staff, { ...us, sellerId }), /permission to sell/);
  await assert.rejects(saveConnectedOffer(stranger, { ...bd, sellerId }), /does not own the shop/);
  await assert.rejects(saveConnectedOffer(seller, { ...bd, sellerId }), /central owner/);
  const firstParty = await saveConnectedOffer(staff, bd);
  await assert.rejects(saveConnectedOffer(marketAdmin, { ...bd, sellerId, expectedRevision: firstParty.revision }), /central owner/);
  const assigned = await saveConnectedOffer(staff, { ...bd, sellerId, expectedRevision: firstParty.revision, amountMinor: 205_500 });
  assert.notEqual(assigned.id, firstParty.id);
  assert.equal(assigned.revision, firstParty.revision + 1);
  const retired = await db.marketOfferIdentity.findUniqueOrThrow({ where: { id: firstParty.id } });
  assert.ok(retired.retiredAt);
  assert.equal(retired.sellerId, storeShop.id);
  assert.equal((retired.retiredTerms as { amountMinor?: number }).amountMinor, 189_900);
  assert.equal((await readConnectedOffer(variantId, "bd", db))?.sellerId, sellerId);

  const edited = await saveConnectedOffer(seller, { ...bd, sellerId, expectedRevision: assigned.revision, amountMinor: 201_500 });
  assert.equal(edited.id, assigned.id);
  await db.marketplaceShopMarket.update({ where: { shopId_marketId: { shopId: sellerId, marketId: "bd" } }, data: { status: "DENIED" } });
  assert.equal(await readConnectedOffer(variantId, "bd", db), null);
  assert.deepEqual((await listProductWorkspace(staff.id, { q: productId, page: 1 }))?.rows[0].markets, []);
  await assert.rejects(saveConnectedOffer(seller, { ...bd, sellerId, expectedRevision: edited.revision }), /permission for this market/);
  await saveConnectedOffer(staff, { ...bd, sellerId, expectedRevision: edited.revision, publication: "ARCHIVED", eligible: false });
  assert.ok((await db.marketOfferIdentity.findUniqueOrThrow({ where: { id: edited.id } })).retiredAt);
  assert.equal(await db.marketOffer.count({ where: { variantId } }), 1);
});

test("draft and archived products have no published markets and archived offers reject new terms", async t => {
  const { staff, productId, variantId, bd, us } = await fixture(t);
  const current = await saveConnectedOffer(staff, bd);
  const listing = () => listProductWorkspace(staff.id, { q: productId, page: 1 });
  assert.deepEqual((await listing())?.rows[0].markets, ["bd"]);
  const draft = await setWorkspaceProductPublication(staff.id, { productId, revision: 0, publication: "DRAFT" });
  assert.deepEqual((await listing())?.rows[0].markets, []);
  await setWorkspaceProductPublication(staff.id, { productId, revision: draft.revision, publication: "ARCHIVED" });
  assert.deepEqual((await listing())?.rows[0].markets, []);
  await assert.rejects(saveConnectedOffer(staff, { ...bd, expectedRevision: current.revision, amountMinor: 1 }),
    { code: "conflict", message: /archived product/ });
  await assert.rejects(saveConnectedOffer(staff, us), { code: "conflict", message: /archived product/ });
  const offers = await db.marketOffer.findMany({ where: { variantId } });
  assert.deepEqual(offers.map(offer => [offer.offerId, offer.revision, offer.amountMinor]),
    [[current.id, current.revision, current.amountMinor]]);
  assert.equal(await readConnectedOffer(variantId, "bd", db), null);
});

test("existing offer rows retain their legacy authority until migration", async t => {
  const { staff, variantId, bd } = await fixture(t);
  await db.marketOffer.create({ data: { variantId, marketId: "bd", currency: "BDT", amountMinor: 7400 } });
  await assert.rejects(saveConnectedOffer(staff, bd), /reconciled during catalog migration/);
  assert.equal(await readConnectedOffer(variantId, "bd", db), null);
  const legacy = await db.marketOffer.findUniqueOrThrow({ where: { variantId_marketId: { variantId, marketId: "bd" } } });
  assert.equal(legacy.offerId, null);
  assert.equal(legacy.amountMinor, 7400);
});
