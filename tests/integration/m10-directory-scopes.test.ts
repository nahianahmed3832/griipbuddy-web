import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { listedCoupons } from "../../src/lib/marketplace/coupon-directory.ts";
import { checkoutCoupon } from "../../src/lib/marketplace/coupons.ts";
import { searchShops, shopperSelections } from "../../src/lib/marketplace/data.ts";
import { applyMarketplaceCommand } from "../../src/lib/marketplace/write.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("market directories expose only explicitly listed, current coupons and eligible shops", async () => {
  const shop = randomUUID();
  const marker = shop.slice(0, 8);
  const data = { kind: "FIXED", value: 1250, minimumMinor: 5000 } as const;
  const privateCode = "PRIVATE-" + marker.toUpperCase();
  const bdCode = "BD-" + marker.toUpperCase();
  const usCode = "US-" + marker.toUpperCase();
  const staleCode = "OLD-" + marker.toUpperCase();
  const wrongShopCode = "WRONG-" + marker.toUpperCase();
  const allCodes = [privateCode, bdCode, usCode, staleCode, wrongShopCode];
  try {
    await db.marketplaceShop.create({ data: { id: shop, slug: "fixture-" + marker, name: "Market scope " + marker,
      published: true, about: "", announcement: "Global fixture", marketGrants: { create: {
        marketId: "bd", status: "APPROVED", profile: { create: { announcement: "Bangladesh only fixture", about: "", presentation: "classic", locale: "en-BD", revision: 1 } },
      } },
    } });
    await db.marketplaceCoupon.createMany({ data: [
      { ...data, code: privateCode, marketId: "bd" },
      { ...data, code: bdCode, marketId: "bd", shopId: shop, publishedInDirectory: true, useLimit: 4 },
      { ...data, code: usCode, marketId: "us", publishedInDirectory: true },
      { ...data, code: staleCode, marketId: "bd", publishedInDirectory: true, endsAt: new Date(0) },
      { ...data, code: wrongShopCode, marketId: "us", shopId: shop, publishedInDirectory: true },
    ] });
    const codes = async (market: "bd" | "us") => (await listedCoupons(market))
      .map(row => row.code).filter(code => allCodes.includes(code));
    assert.deepEqual(await codes("bd"), [bdCode]);
    assert.deepEqual(await codes("us"), [usCode]);
    assert.deepEqual(await checkoutCoupon(db, "bd", privateCode, [{ shopId: shop, netMinor: 5000 }]),
      { total: 1250, discounts: [1250] });
    assert.equal((await searchShops(marker, "bd"))[0]?.announcement, "Bangladesh only fixture");
    assert.deepEqual(await searchShops(marker, "us"), []);
    await db.marketplaceCoupon.update({ where: { code: bdCode }, data: { enabled: false } });
    assert.deepEqual(await codes("bd"), []);
    await db.marketplaceCoupon.update({ where: { code: bdCode }, data: { enabled: true } });
    await db.marketplaceShopMarket.update({ where: { shopId_marketId: { shopId: shop, marketId: "bd" } },
      data: { status: "DENIED" } });
    assert.deepEqual(await codes("bd"), []);
    assert.deepEqual(await searchShops(marker, "bd"), []);
  } finally {
    await db.marketplaceCoupon.deleteMany({ where: { code: { in: allCodes } } });
    await db.sellerMarketProfile.deleteMany({ where: { shopId: shop } });
    await db.marketplaceShop.deleteMany({ where: { id: shop } });
  }
});

test("a followed shop is visible only to its shopper and eligible markets", async () => {
  const buyer = randomUUID(), other = randomUUID(), shop = randomUUID();
  try {
    await db.shopper.createMany({ data: [buyer, other].map(id => ({ id, email: id + "@example.invalid", name: "Fixture buyer" })) });
    await db.marketplaceShop.create({ data: { id: shop, slug: "fixture-" + shop, name: "Follow fixture",
      published: true, about: "", announcement: "", marketGrants: { create: { marketId: "bd", status: "APPROVED" } },
    } });
    const follow = { action: "follow", shop, selected: true } as const;
    await assert.rejects(() => applyMarketplaceCommand(follow, { shopperId: buyer, marketId: "us" }), { status: 404 });
    await applyMarketplaceCommand(follow, { shopperId: buyer, marketId: "bd" });
    await applyMarketplaceCommand(follow, { shopperId: buyer, marketId: "bd" });
    assert.equal(await db.shopperFollow.count({ where: { shopId: shop } }), 1);
    assert.equal((await shopperSelections(buyer, "bd")).shops[0]?.id, shop);
    assert.deepEqual((await shopperSelections(buyer, "us")).shops, []);
    assert.deepEqual((await shopperSelections(other, "bd")).shops, []);
    await assert.rejects(() => applyMarketplaceCommand({ ...follow, selected: false }, { shopperId: buyer, marketId: "us" }), { status: 404 });
    await applyMarketplaceCommand({ ...follow, selected: false }, { shopperId: buyer, marketId: "bd" });
    assert.equal(await db.shopperFollow.count({ where: { shopId: shop } }), 0);
  } finally {
    await db.marketplaceShop.deleteMany({ where: { id: shop } });
    await db.shopper.deleteMany({ where: { id: { in: [buyer, other] } } });
  }
});
