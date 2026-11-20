import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { handleMainAdminCatalog } from "../../src/lib/catalog/main-admin-api.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { storeShop } from "../../src/lib/marketplace/constants.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("the signed Marketplace workspace keeps seller grants and checkout changes in the selected market", async t => {
  const suffix = randomBytes(5).toString("hex");
  const prefix = `marketplace-${suffix}`;
  const marketId = "bd" as const;
  const owner = { id: `${prefix}-owner`, legacyId: randomBytes(12).toString("hex"), role: "OWNER" } as const;
  const packer = { id: `${prefix}-packer`, legacyId: randomBytes(12).toString("hex"), role: "PACKER" } as const;
  const staff = [owner, packer];
  const shopId = randomUUID();
  const secret = randomBytes(48).toString("hex");
  const homepageSecret = randomBytes(48).toString("hex");
  const district = `fixture-${suffix.replace(/\d/g, digit => String.fromCharCode(97 + Number(digit)))}`;
  const originalPolicy = await db.checkoutPolicy.findUnique({ where: { marketId } });
  const config = {
    CHECKOUT_SECRET: randomBytes(48).toString("hex"),
    GRIIP_MARKETPLACE_PREVIEW: "1", GRIIP_FIRST_PARTY_STOREFRONT: "0", GRIIP_HYBRID_STOREFRONT: "0",
    GRIIP_MARKET_CONFIGURATION: "", GRIIP_MAIN_ADMIN_HOMEPAGE_ENABLED: "1", GRIIP_MAIN_ADMIN_MARKETPLACE_ENABLED: "1",
    GRIIP_MAIN_ADMIN_HOMEPAGE_ORIGIN: "http://127.0.0.1:4339", GRIIP_MAIN_ADMIN_HOMEPAGE_SECRET: homepageSecret,
    GRIIP_MAIN_ADMIN_HOMEPAGE_ACTORS: JSON.stringify(Object.fromEntries(staff.map(actor => [actor.legacyId, actor.id]))),
    GRIIP_MAIN_ADMIN_MARKETPLACE_SECRET: secret,
  };
  const previous = Object.keys(config).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, config);

  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await db.auditEvent.deleteMany({ where: { actorId: owner.id } });
    await db.deliveryZone.deleteMany({ where: { marketId, district } });
    if (originalPolicy) await db.checkoutPolicy.update({ where: { marketId }, data: originalPolicy });
    else await db.checkoutPolicy.deleteMany({ where: { marketId } });
    await db.marketOffer.deleteMany({ where: { variantId: `${prefix}-variant` } });
    await db.variant.deleteMany({ where: { id: `${prefix}-variant` } });
    await db.product.deleteMany({ where: { id: `${prefix}-listing` } });
    await db.department.deleteMany({ where: { id: prefix } });
    await db.marketplaceShop.deleteMany({ where: { id: shopId } });
    await db.user.deleteMany({ where: { id: { in: staff.map(actor => actor.id) } } });
  });

  for (const actor of staff) {
    await db.user.create({ data: { id: actor.id, name: actor.id, email: `${actor.id}@example.invalid`,
      staff: { create: { role: actor.role, ...(actor.role === "PACKER" && {
        marketGrants: { create: { marketId, merchandising: true, commercial: true, operations: true } },
      }) } },
    } });
  }
  await db.marketplaceShop.create({ data: { id: shopId, name: `Fixture shop ${suffix}`, slug: prefix,
    announcement: "", about: "", marketGrants: { create: { marketId } } },
  });
  await db.department.create({ data: { id: prefix, slug: prefix, name: "Marketplace fixture", shortName: "Fixture",
    description: "", imageSrc: "/catalog/phone-stand.webp", imageAlt: "Fixture", position: 0 },
  });
  await db.product.create({ data: { id: `${prefix}-listing`, slug: `${prefix}-listing`, departmentId: prefix,
    marketplaceShopId: shopId, name: "Bangladesh listing", description: "", addedOn: new Date(), position: 0, specifications: [],
    variants: { create: { id: `${prefix}-variant`, sku: `${prefix}-SKU`, options: {}, label: "Default", position: 0,
      offers: { create: { marketId, currency: "BDT", amountMinor: 999 } },
    } },
  } });

  function signed(operation: object, options: { actor?: typeof staff[number]; market?: "bd" | "us"; key?: string } = {}) {
    const actor = options.actor ?? owner;
    const body = JSON.stringify({ issuedAt: Date.now(), nonce: randomUUID(), legacyId: actor.legacyId,
      central: actor.role === "OWNER", marketId: options.market ?? marketId, request: operation });
    const signature = createHmac("sha256", options.key ?? secret).update("griip-main-admin-marketplace-v1\n").update(body).digest("hex");
    return () => handleMainAdminCatalog(new Request("http://127.0.0.1:4340/api/internal/main-admin-catalog", {
      method: "POST", body, headers: { "content-type": "application/json", "x-griip-catalog-signature": signature,
        "x-griip-admin-channel": "marketplace" },
    }));
  }

  async function send(operation: object, status = 200, options?: Parameters<typeof signed>[1]) {
    const response = await signed(operation, options)();
    const payload = await response.json();
    assert.equal(response.status, status, JSON.stringify(payload));
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    return payload;
  }

  const read = { read: "marketplace-workspace", q: suffix };
  await send(read, 401, { key: homepageSecret });
  await send(read, 403, { actor: packer });
  await send({ ...read, marketId: "us" }, 400);

  const bangladesh = (await send(read)).data;
  const unitedStates = (await send(read, 200, { market: "us" })).data;
  assert.equal(bangladesh.market.currency, "BDT");
  assert.equal(bangladesh.canConfigureCheckout, true);
  assert.deepEqual(bangladesh.sellers, [{ id: shopId, name: `Fixture shop ${suffix}`, slug: prefix,
    published: false, grantStatus: "PENDING", listings: [{ id: `${prefix}-listing`, name: "Bangladesh listing", publication: "DRAFT" }] }]);
  assert.equal(unitedStates.market.currency, "USD");
  assert.equal(unitedStates.canConfigureCheckout, false);
  assert.equal(unitedStates.sellers[0].grantStatus, null);
  assert.deepEqual(unitedStates.sellers[0].listings, []);

  const approve = { action: "marketplace.seller.grant", input: { sellerId: shopId, status: "APPROVED" } };
  const publish = { action: "marketplace.seller.publish", input: { sellerId: shopId, published: true } };
  await send(approve, 403, { actor: packer });
  await send(approve, 404, { market: "us" });
  await send({ ...approve, input: { ...approve.input, marketId: "us" } }, 400);
  await send({ ...publish, input: { ...publish.input, sellerId: storeShop.id } }, 404);
  const replay = signed(approve);
  assert.equal((await replay()).status, 200);
  assert.equal((await replay()).status, 409);
  await send(publish);
  assert.equal((await send(read)).data.sellers[0].grantStatus, "APPROVED");
  const publishedUS = (await send(read, 200, { market: "us" })).data.sellers[0];
  assert.equal(publishedUS.published, true);
  assert.equal(publishedUS.grantStatus, null);
  process.env.GRIIP_FIRST_PARTY_STOREFRONT = "1";
  assert.equal((await send(read)).data.thirdPartyEnabled, false);
  await send({ ...publish, input: { ...publish.input, published: false } }, 403);
  process.env.GRIIP_FIRST_PARTY_STOREFRONT = "0";

  const policy = { action: "marketplace.policy.save", input: {
    revision: originalPolicy?.revision ?? null, enabled: false, codEnabled: true, taxBasisPoints: 0, taxLabel: "Test tax",
  } };
  const delivery = { action: "marketplace.delivery.save", input: { revision: null, district, districtLabel: "Fixture district",
    method: "test-delivery", label: "Fixture delivery", guidance: "Isolated test option", chargeMinor: 0, enabled: false, codEligible: true,
  } };
  await send(policy, 403, { market: "us" });
  await send(delivery, 403, { market: "us" });
  await send(policy);
  await send(policy, 422);
  await send(delivery);
  await send(delivery, 422);
  const saved = (await send(read)).data.checkout;
  assert.equal(saved.enabled, false);
  assert.equal(saved.taxBasisPoints, 0);
  assert.deepEqual(saved.deliveryZones.find((zone: { district: string }) => zone.district === district),
    { marketId, ...delivery.input, revision: 0 });
  assert.deepEqual((await send(read, 200, { market: "us" })).data.checkout, unitedStates.checkout);
  assert.equal(await db.auditEvent.count({ where: { actorId: owner.id, target: shopId } }), 2);
  assert.equal(await db.auditEvent.count({ where: { actorId: owner.id, action: "MARKET_SETTINGS_CHANGED" } }), 2);
});
