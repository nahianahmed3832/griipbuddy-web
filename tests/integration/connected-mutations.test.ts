import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import "../../scripts/load-env.ts";
import type { MarketId } from "../../src/config/markets.ts";
import { handleCatalogMutation } from "../../src/lib/catalog/admin-api.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { storeShop } from "../../src/lib/marketplace/constants.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

type Actor = Awaited<ReturnType<Parameters<typeof handleCatalogMutation>[1]["actor"]>>;

function mutate(actor: Actor, action: string, input: object, market: MarketId = "bd", origin?: string) {
  const canonicalOrigin = new URL(process.env.BETTER_AUTH_URL!).origin;
  return handleCatalogMutation(new Request(new URL("/api/staff/catalog", canonicalOrigin), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin ?? canonicalOrigin },
    body: JSON.stringify({ action, input }),
  }), { actor: async () => actor, market: async () => market });
}

async function checked(response: Response, status = 200, code?: string) {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  if (code) assert.equal(body.error?.code, code);
  return body;
}

async function fixture(t: TestContext) {
  const prefix = `stage6-mutation-${randomUUID().slice(0, 8)}`;
  const owner = { kind: "staff", role: "OWNER", id: `${prefix}-owner` } as const;
  const commercial = { kind: "staff", role: "PACKER", id: `${prefix}-commercial` } as const;
  const seller = { kind: "seller", id: `${prefix}-seller` } as const;
  const otherSeller = { kind: "seller", id: `${prefix}-other-seller` } as const;
  const sellerId = randomUUID();
  const otherSellerId = randomUUID();
  const root = `${prefix}-department`;
  const branch = `${prefix}-category`;
  const leaf = `${prefix}-leaf`;
  const productId = `${prefix}-product`;
  const variantId = `v-${productId}`;
  const deviceId = `${prefix}-device`;
  const envNames = ["GRIIP_MARKETPLACE_PREVIEW", "GRIIP_FIRST_PARTY_STOREFRONT", "GRIIP_HYBRID_STOREFRONT"] as const;
  const env = envNames.map(name => [name, process.env[name]] as const);
  Object.assign(process.env, { GRIIP_MARKETPLACE_PREVIEW: "1", GRIIP_FIRST_PARTY_STOREFRONT: "0", GRIIP_HYBRID_STOREFRONT: "0" });
  t.after(async () => {
    try {
      await db.auditEvent.deleteMany({ where: { OR: [{ target: { startsWith: prefix } }, { target: variantId }] } });
      await db.marketOffer.deleteMany({ where: { variantId } });
      await db.marketOfferIdentity.deleteMany({ where: { variantId } });
      await db.variant.deleteMany({ where: { id: variantId } });
      await db.product.deleteMany({ where: { id: productId } });
      await db.deviceModel.deleteMany({ where: { id: deviceId } });
      for (const id of [leaf, branch, root]) await db.department.deleteMany({ where: { id } });
      await db.marketplaceShop.deleteMany({ where: { id: { in: [sellerId, otherSellerId] } } });
      await db.shopper.deleteMany({ where: { id: { in: [seller.id, otherSeller.id] } } });
      await db.user.deleteMany({ where: { id: { in: [owner.id, commercial.id] } } });
    } finally {
      for (const [name, value] of env) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
  for (const actor of [owner, commercial]) {
    await db.user.create({
      data: { id: actor.id, name: "Catalog test staff", email: `${actor.id}@example.invalid`,
        staff: { create: { role: actor.role, ...(actor.role === "PACKER" && {
          marketGrants: { create: { marketId: "bd", commercial: true } },
        }) } } },
    });
  }
  for (const [shopId, actor] of [[sellerId, seller], [otherSellerId, otherSeller]] as const) {
    await db.shopper.create({
      data: { id: actor.id, name: "Catalog test seller", email: `${actor.id}@example.invalid`,
        shop: { create: { id: shopId, slug: actor.id, name: "Catalog test shop", about: "", announcement: "",
          published: true, marketGrants: { create: { marketId: "bd", status: "APPROVED" } } } } },
    });
  }
  const category = { slug: root, id: root, kind: "DEPARTMENT", parentId: null, state: "ACTIVE", revision: null,
    name: "Connected test department", shortName: "Test department", description: "",
    image: { src: "/catalog/phone-stand.webp", alt: "Catalog sample" }, position: 10 };
  await checked(await mutate(owner, "category.save", category));
  await checked(await mutate(owner, "category.save", { ...category, id: branch, slug: branch, kind: "CATEGORY", parentId: root }));
  await checked(await mutate(owner, "category.save", { ...category, id: leaf, slug: leaf, kind: "SUBCATEGORY", parentId: branch }));
  const product = { id: productId, slug: productId, primaryCategoryId: leaf, expectedRevision: null,
    name: "Catalog fixture", description: "A product managed by the connected APIs.", publication: "DRAFT", options: [],
    variants: [{ id: variantId, sku: productId.toUpperCase(), selections: {} }] };
  const offer = { variantId, marketId: "bd", sellerId: storeShop.id, expectedRevision: null, amountMinor: 179_900,
    publication: "ACTIVE", eligible: false };
  return { owner, commercial, seller, otherSeller, sellerId, otherSellerId, category, leaf, productId, variantId, deviceId, product, offer };
}

test("catalog commands enforce same-origin session, shared identity scope, allowlisted fields, and revisioned audits", async t => {
  const { owner, commercial, seller, category, leaf, productId, variantId, product, offer, deviceId } = await fixture(t);
  await checked(await mutate(null, "product.save", product), 401, "authentication_required");
  await checked(await mutate(owner, "product.save", product, "bd", "https://unrelated.example.invalid"), 403, "forbidden");
  await checked(await mutate(commercial, "product.save", product), 403, "forbidden");
  await checked(await mutate(seller, "category.archive", { id: leaf, revision: 0 }), 403, "forbidden");
  await checked(await mutate(owner, "inventory.adjust", { variantId, stock: 3 }), 400, "invalid_input");
  const invalid = await checked(await mutate(owner, "product.save", { ...product,
    variants: [{ ...product.variants[0], stock: 3 }] }), 400, "invalid_input");
  assert.ok(invalid.error.fields.some((field: { path: string }) => field.path === "variants.0"));
  await checked(await mutate(owner, "product.save", { ...product, publication: "ACTIVE" }), 400, "invalid_input");
  assert.equal(await db.product.count({ where: { id: productId } }), 0);

  const saved = await checked(await mutate(owner, "product.save", product));
  assert.deepEqual(saved.data, { id: productId, revision: 0 });
  await checked(await mutate(owner, "category.save", { ...category, revision: 90 }), 409, "conflict");
  await checked(await mutate(owner, "product.save", product), 409, "conflict");
  await checked(await mutate(owner, "device.save", {
    id: deviceId, name: "Fixture handset", brand: deviceId, revision: null, aliases: [],
  }));
  await checked(await mutate(owner, "variant.compatibility", {
    productId, variantId: `v-${deviceId}`, revision: 0, modelIds: [deviceId],
  }), 404, "not_found");
  const fitment = await checked(await mutate(owner, "variant.compatibility", {
    productId, variantId, revision: 0, modelIds: [deviceId],
  }));
  assert.equal(fitment.data.revision, 1);
  const audit = await db.auditEvent.findMany({ where: { target: productId, action: "PRODUCT_SAVED" } });
  assert.equal(audit.length, 2);
  assert.ok(audit.every(event => event.actorId === owner.id));
  assert.equal(await db.inventoryPool.count({ where: { variantId } }), 0);
  await checked(await mutate(owner, "product.gallery", { productId, revision: 1, images: [category.image] }));
  await checked(await mutate(owner, "offer.save", offer));
  await checked(await mutate(owner, "product.publish", { productId, revision: 2 }));
  await checked(await mutate(owner, "category.archive", { id: leaf, revision: 0 }), 422, "rule_violation");
});

test("offers enforce selected market, commercial grants and assigned seller, with private responses", async t => {
  const { owner, commercial, seller, otherSeller, sellerId, otherSellerId, product, offer, variantId } = await fixture(t);
  await checked(await mutate(owner, "product.save", product));
  await checked(await mutate(commercial, "offer.save", { ...offer, marketId: "us", amountMinor: 1799 }), 409, "market_mismatch");
  await checked(await mutate(commercial, "offer.save", { ...offer, marketId: "us", amountMinor: 1799 }, "us"), 403, "forbidden");
  await checked(await mutate(owner, "offer.save", { ...offer, currency: "USD" }), 400, "invalid_input");
  await checked(await mutate(owner, "offer.save", { ...offer, warehouseId: "private-fixture" }), 400, "invalid_input");
  await checked(await mutate(owner, "offer.save", { ...offer, eligible: true }), 400, "invalid_input");
  assert.equal(await db.marketOffer.count({ where: { variantId } }), 0);

  const current = await checked(await mutate(commercial, "offer.save", offer));
  assert.equal(current.data.currency, "BDT");
  const usd = await checked(await mutate(owner, "offer.save", { ...offer, marketId: "us", amountMinor: 1799 }, "us"));
  assert.equal(usd.data.currency, "USD");
  assert.equal(usd.data.amountMinor, 1799);
  assert.notEqual(usd.data.id, current.data.id);
  const assigned = await checked(await mutate(owner, "offer.save", {
    ...offer, sellerId, expectedRevision: current.data.revision,
  }));
  await checked(await mutate(otherSeller, "offer.save", { ...offer, sellerId, expectedRevision: assigned.data.revision }), 403, "forbidden");
  await checked(await mutate(otherSeller, "offer.save", { ...offer, sellerId: otherSellerId, expectedRevision: 99 }), 403, "forbidden");
  await checked(await mutate(seller, "offer.save", { ...offer, sellerId, expectedRevision: 0 }), 409, "conflict");
  const updated = await checked(await mutate(seller, "offer.save", {
    ...offer, sellerId, expectedRevision: assigned.data.revision, amountMinor: 180_000,
  }));
  assert.equal(updated.data.id, assigned.data.id);
  assert.equal(updated.data.amountMinor, 180_000);
  await db.marketplaceShopMarket.update({ where: { shopId_marketId: { shopId: sellerId, marketId: "bd" } }, data: { status: "DENIED" } });
  await checked(await mutate(seller, "offer.save", { ...offer, sellerId, expectedRevision: updated.data.revision }), 403, "forbidden");
  const prices = await db.auditEvent.findMany({ where: { action: "PRICE_CHANGED", target: variantId } });
  assert.equal(prices.length, 4);
  const sellerChange = prices.map(row => row.changes as { actor?: Actor; offerId?: string; marketId?: string })
    .find(change => change.actor?.kind === "seller");
  assert.deepEqual(sellerChange?.actor, seller);
  assert.equal(sellerChange?.offerId, updated.data.id);
  assert.equal(sellerChange?.marketId, "bd");
});
