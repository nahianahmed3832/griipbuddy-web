import "./load-env.ts";
import { marketIds } from "../src/config/markets.ts";
import { offers } from "../prisma/demo-data.ts";
import { getDb } from "../src/lib/db/client.ts";
import { stagingDatabase } from "../src/lib/db/local.ts";
import { marketConfiguration } from "../src/lib/market-config.ts";
import { homepageEditorData, publishHomepage, saveHomepageDraft } from "../src/lib/staff/homepage.ts";
import type { HomepageContentData, HomepageScope } from "../src/lib/catalog/homepage-contract.ts";

if (process.env.GRIIP_MARKET_REVIEW_FIXTURES !== "1" || !stagingDatabase()) {
  throw new Error("Review fixtures require the dedicated market review staging database.");
}
if (marketIds.some(id => marketConfiguration(id).status !== "staging" ||
    marketConfiguration(id).catalog.inventory !== "market-locations")) throw new Error("Load the review market profile first.");

const db = getDb();
try {
  const owner = await db.staffAccess.findFirstOrThrow({ where: { active: true, role: "OWNER" }, select: { userId: true } });
  await db.$transaction(async tx => {
    await tx.checkoutPolicy.update({
      where: { marketId: "us" },
      data: { enabled: true, codEnabled: true, taxTreatment: "MERCHANDISE_RATE", taxBasisPoints: 700, taxLabel: "US fixture tax (7%)" },
    });
    const usServices = [
      { district: "ny", districtLabel: "New York", method: "ground", label: "Fixture ground delivery", chargeMinor: 695 },
      { district: "ny", districtLabel: "New York", method: "express", label: "Fixture express delivery", chargeMinor: 1295 },
    ];
    for (const service of usServices) {
      await tx.deliveryZone.upsert({
        where: { marketId_district_method: { marketId: "us", district: service.district, method: service.method } },
        create: { marketId: "us", ...service }, update: {},
      });
    }
    for (const marketId of marketIds) {
      const market = marketConfiguration(marketId);
      const locationId = `review-dispatch-${marketId}`;
      await tx.dispatchLocation.upsert({
        where: { id: locationId }, update: {},
        create: { id: locationId, marketId, name: `${market.name} fixture dispatch` },
      });
      for (const row of offers.filter(offer => offer.marketId === marketId)) {
        await tx.locationInventory.upsert({
          where: { variantId_locationId: { variantId: row.variantId, locationId } }, update: {},
          create: { variantId: row.variantId, locationId, available: row.variantId === "v-mug-lilac" ? 0 : row.stock },
        });
      }
    }
  });

  const publish = async (scope: HomepageScope, sections: HomepageContentData["sections"]) => {
    if (await homepageEditorData(owner.userId, scope)) return;
    await saveHomepageDraft(owner.userId, scope, 0, { sections });
    await publishHomepage(owner.userId, scope, 1);
  };
  await publish({}, [
    { key: "hero", type: "BANNER", position: 1, title: "Everyday pieces, thoughtfully chosen",
      productIds: ["p-tote", "p-notebooks"], link: { label: "Explore the shop", href: "/shop" } },
    { key: "trending", type: "TRENDING", position: 7, title: "Trending locally", fallbackIds: ["p-tee", "p-beanie"] },
  ]);
  await publish({ marketId: "bd" }, [
    { key: "hero", type: "BANNER", position: 1, title: "Shop the Bangladesh collection",
      productIds: ["p-tote", "p-notebooks"], link: { label: "Browse Bangladesh", href: "/shop" } },
  ]);
  await publish({ marketId: "us" }, [
    { key: "hero", type: "BANNER", position: 1, title: "Shop the United States collection",
      productIds: ["p-tote", "p-notebooks"], link: { label: "Browse United States", href: "/shop" } },
  ]);
  await publish({ marketId: "us", locale: "es-US" }, [
    { key: "hero", type: "BANNER", position: 1, title: "Descubre la colección de Estados Unidos",
      productIds: ["p-tote", "p-notebooks"], link: { label: "Explorar la tienda", href: "/shop" } },
  ]);
  console.log("Seeded isolated Bangladesh and United States review fixtures.");
} finally {
  await db.$disconnect();
}
