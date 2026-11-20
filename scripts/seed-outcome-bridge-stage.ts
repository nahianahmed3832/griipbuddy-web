import "./load-env.ts";
import { integratedCheckout, recoveredRequest } from "../src/lib/commerce/integrated-checkout.ts";
import { getDb } from "../src/lib/db/client.ts";
import { stagingDatabase } from "../src/lib/db/local.ts";

if (process.env.GRIIP_MARKET_REVIEW_FIXTURES !== "1" || !stagingDatabase() ||
    integratedCheckout("bd") !== "http://outcome-legacy-api:38100") {
  throw new Error("Run against the dedicated legacy outcome validation staging profile.");
}

// Keep the storefront listing aligned with the recovered API fixtures.
const sourceProduct = "000000000000000000000003";
const sourceVariant = "000000000000000000000005";
const amountMinor = 80_000;
const sku = "FIXTURE-BD-BLUE";
const productId = "p-" + sourceProduct;
const variantId = "v-" + sourceVariant;
const slug = "legacy-outcome-bridge-fixture";
const image = { src: "/editorial/tech.webp", alt: "Staging electronics fixture" };
const stock = await recoveredRequest<{ totalAvailableQuantity: number }>(`/stocks/${sourceProduct}/${sourceVariant}`);
if (!Number.isInteger(stock.totalAvailableQuantity) || stock.totalAvailableQuantity < 1) {
  throw new Error("The isolated checkout source has no in-stock variant.");
}

const db = getDb();
try {
  await db.$transaction(async tx => {
    const existing = await tx.product.findUnique({ where: { id: productId }, select: { slug: true, demo: true } });
    const variant = await tx.variant.findUnique({ where: { id: variantId }, select: { sku: true, productId: true } });
    if ((existing && (!existing.demo || existing.slug !== slug)) ||
        (variant && (variant.productId !== productId || variant.sku !== sku))) {
      throw new Error("The proposed legacy fixture identifiers belong to existing catalog records.");
    }

    const department = await tx.department.upsert({
      where: { id: "legacy-outcome-bridge-fixtures" }, update: {},
      create: { id: "legacy-outcome-bridge-fixtures", slug: "legacy-outcome-bridge-fixtures",
        name: "Legacy checkout fixtures", shortName: "Legacy checkout fixtures", description: "Isolated test products.",
        imageSrc: image.src, imageAlt: image.alt, position: 0 },
    });
    await tx.product.upsert({
      where: { id: productId }, update: { active: true },
      create: { id: productId, slug, departmentId: department.id, name: "Legacy outcome bridge fixture",
        description: "Synthetic catalog item for the isolated legacy checkout validation.",
        specifications: [], keywords: ["test", "checkout"], addedOn: new Date(), position: 0,
        publication: "ACTIVE", demo: true, images: { create: { ...image, position: 0 } } },
    });
    await tx.variant.upsert({
      where: { id: variantId }, update: {},
      create: { id: variantId, productId, sku, label: "Standard", options: { Color: "Blue" }, position: 0 },
    });
    await tx.marketOffer.upsert({
      where: { variantId_marketId: { variantId, marketId: "bd" } }, update: { amountMinor, eligible: true },
      create: { variantId, marketId: "bd", currency: "BDT", amountMinor },
    });
  });
  console.log(JSON.stringify({ fixture: slug, variantId, amountMinor, available: stock.totalAvailableQuantity }));
} finally {
  await db.$disconnect();
}
