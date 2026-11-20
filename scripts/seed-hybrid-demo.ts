import "./load-env.ts";
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { getDb } from "../src/lib/db/client.ts";
import { demoEmail, demoPhone } from "../src/lib/marketplace/phone.ts";
import { storeShop } from "../src/lib/marketplace/constants.ts";
import { hybridDemoMode } from "../src/lib/release-config.ts";

if (!hybridDemoMode() || process.env.ALLOW_DEMO_SEED !== "1" || process.stdin.isTTY) {
  throw new Error("Seed the isolated hybrid demo database with a demo password on stdin.");
}

let password = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  password += chunk;
  if (password.length > 10) throw new Error("Use an eight-digit demo password.");
}
password = password.trim();
if (!/^\d{8}$/.test(password)) throw new Error("Use an eight-digit demo password.");
const credential = await hashPassword(password);
await import("./seed.ts");

const db = getDb();
const shopperId = "hybrid-demo-shopper";
const reviewShopperId = "hybrid-demo-example-reviewer";
const staffId = "hybrid-demo-admin";
const sellerId = "00000000-0000-4000-8000-000000000014";
const exampleAttemptId = "00000000-0000-4000-8000-000000000015";
const expiry = new Date(Date.now() + 14 * 86400_000);

try {
  await db.$transaction(async tx => {
    await tx.shopper.upsert({ where: { id: shopperId }, update: {}, create: {
      id: shopperId, name: "Demo shopper", email: demoEmail, emailVerified: true, phoneNumber: demoPhone, phoneNumberVerified: true,
      accounts: { create: { id: randomUUID(), accountId: shopperId, providerId: "credential", password: credential } },
    } });
    await tx.user.upsert({ where: { id: staffId }, update: {}, create: {
      id: staffId, name: "Demo owner", email: demoEmail, emailVerified: true,
      accounts: { create: { id: randomUUID(), accountId: staffId, providerId: "credential", password: credential } },
      staff: { create: { role: "OWNER", active: true } },
    } });
    await tx.marketplaceShop.upsert({ where: { id: storeShop.id }, update: {}, create: {
      id: storeShop.id, name: storeShop.name, slug: storeShop.slug, published: true, announcement: "",
      about: "Products sold directly by GriipBuddy.",
    } });
    await tx.marketplaceShop.upsert({ where: { id: sellerId }, update: {}, create: {
      id: sellerId, owner: { connect: { id: shopperId } }, name: "Thread & Co. Demo", slug: "thread-and-co-demo", published: true,
      announcement: "Bangladesh demo shop", about: "A sample seller for testing listing, market approvals and fulfillment.",
      marketGrants: { create: [{ marketId: "bd", status: "APPROVED" }, { marketId: "us", status: "DENIED" }] },
    } });
    await tx.product.updateMany({ where: { id: "p-beanie", marketplaceShopId: null }, data: { marketplaceShopId: sellerId } });
    const roots = await tx.department.findMany({ where: { slug: { in: ["fashion", "phone-cases"] } }, select: {
      id: true, slug: true, imageSrc: true, imageAlt: true,
    } });
    const fashion = roots.find(row => row.slug === "fashion");
    if (fashion) {
      for (const [slug, label, ids] of [
        ["tops", "Tops", ["p-tee"]], ["fashion-accessories", "Bags & Accessories", ["p-tote", "p-beanie"]],
        ["shoes", "Shoes", ["p-sneakers"]],
      ] as const) {
        await tx.department.upsert({ where: { id: `d-demo-${slug}` }, update: {}, create: {
          id: `d-demo-${slug}`, slug: `fashion-${slug}`, name: label, shortName: label, description: "",
          parentId: fashion.id, imageSrc: fashion.imageSrc, imageAlt: fashion.imageAlt, position: 20,
        } });
        await tx.product.updateMany({ where: { id: { in: [...ids] }, departmentId: fashion.id }, data: { departmentId: `d-demo-${slug}` } });
      }
    }
    const cases = roots.find(row => row.slug === "phone-cases");
    if (cases) {
      await tx.department.upsert({ where: { id: "d-mobile-tech" }, update: {}, create: {
        id: "d-mobile-tech", slug: "mobile-tech", name: "Mobile & Tech", shortName: "Mobile & Tech", position: 8,
        description: "Cases, screen protection and tech accessories.", imageSrc: cases.imageSrc, imageAlt: cases.imageAlt,
      } });
      await tx.department.updateMany({ where: {
        slug: { in: ["phone-cases", "screen-and-camera-protectors", "tech-accessories", "other-models", "combo-offer"] },
        parentId: null,
      }, data: { parentId: "d-mobile-tech" } });
    }
    const tee = await tx.product.findUnique({ where: { id: "p-tee" }, select: { specifications: true, keywords: true } });
    if (tee && Array.isArray(tee.specifications) && !tee.keywords.includes("add-on:canvas-carryall-tote")) {
      await tx.product.update({ where: { id: "p-tee" }, data: {
        specifications: [
          ...tee.specifications.filter(item => item !== null),
          { label: "Size guide: S", value: "Chest 100 cm · Length 66 cm" },
          { label: "Size guide: M", value: "Chest 106 cm · Length 69 cm" },
          { label: "Size guide: L", value: "Chest 112 cm · Length 72 cm" },
        ],
        keywords: [...tee.keywords, "add-on:canvas-carryall-tote", "add-on:rib-knit-beanie"],
      } });
    }
    const promo = await tx.marketOffer.findMany({ where: { variantId: {
      in: ["v-tee-sage-s", "v-tee-sage-m", "v-tee-charcoal-s", "v-tee-charcoal-m", "v-tote-plum", "v-beanie-caramel"],
    }, discountMinor: null } });
    for (const offer of promo) await tx.marketOffer.update({
      where: { variantId_marketId: { variantId: offer.variantId, marketId: offer.marketId } },
      data: { discountMinor: Math.floor(offer.amountMinor * (offer.marketId === "bd" ? .2 : .15)), discountStartsAt: new Date(), discountEndsAt: expiry },
    });
    await tx.shopper.upsert({ where: { id: reviewShopperId }, update: {}, create: {
      id: reviewShopperId, name: "Sample reviewer", email: "sample-review@griipbuddy.invalid",
    } });
    await tx.checkoutAttempt.upsert({ where: { id: exampleAttemptId }, update: {}, create: {
      id: exampleAttemptId, guestKey: "0".repeat(64), requestHash: "0".repeat(64),
      order: { create: {
        reference: "GB-DEMO-TEE", shopperId: reviewShopperId, marketId: "bd", currency: "BDT", fulfillmentStatus: "DELIVERED",
        customerName: "Sample buyer", phone: "01700000000", district: "dhaka", districtLabel: "Dhaka",
        locality: "Demo", address: "Example address", deliveryMethod: "standard", deliveryLabel: "Demo delivery",
        taxLabel: "Test tax", subtotalMinor: 89000, discountMinor: 0, deliveryMinor: 8000, taxMinor: 0, totalMinor: 97000,
        measurementTest: true,
        items: { create: { variantId: "v-tee-sage-s", sku: "GB-TEE-SAGE-S", productName: "Weekend Cotton Tee",
          variantName: "Sage / S", quantity: 1, currency: "BDT", unitPriceMinor: 89000, unitDiscountMinor: 0, lineTotalMinor: 89000 } },
        payment: { create: { method: "COD", status: "COLLECTED", amountMinor: 97000, currency: "BDT" } },
      } },
    } });
    const example = await tx.order.findUniqueOrThrow({ where: { attemptId: exampleAttemptId }, select: { id: true } });
    await tx.shopperReview.upsert({
      where: { orderId_productId: { orderId: example.id, productId: "p-tee" } }, update: {},
      create: { orderId: example.id, productId: "p-tee", shopperId: reviewShopperId, stars: 5, visible: true,
        text: "Sample review showing the fit and fabric rating on a test listing." },
    });
  }, { timeout: 45_000 });
  console.log("Seeded synthetic admin, shopper, seller and merchandising data in the isolated hybrid demo.");
} finally {
  await db.$disconnect();
}
