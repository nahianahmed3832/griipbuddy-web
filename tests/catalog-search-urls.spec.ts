import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { getDb } from "../src/lib/db/client";
import { requireLocalDatabase } from "../src/lib/db/local";
import { storeShop } from "../src/lib/marketplace/constants";

test("legacy links retain the exact selection and preview URLs stay out of the index", async ({ page, baseURL }) => {
  test.skip(process.env.GRIIP_CATALOG_STAGE11_BROWSER !== "1", "Use the disposable Stage 11 fixture profile.");
  requireLocalDatabase("griipbuddy_test");
  if (!baseURL || new URL(baseURL).hostname !== "127.0.0.1" || baseURL !== process.env.BETTER_AUTH_URL) {
    throw new Error("Use the loopback storefront for catalog URL verification.");
  }
  await page.context().route("**/*", route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());

  const db = getDb();
  const productId = `stage11-url-${randomUUID().slice(0, 8)}`;
  const sourceProductId = `${productId}-old`;
  const sizes = ["Small", "Large", "Extra large"];
  const variantIds = sizes.map((_, index) => `v-${productId}-${index}`);
  const image = { src: "/catalog/phone-stand.webp", alt: "Fixture charging stand", position: 0 };
  const category = await db.department.findFirstOrThrow({ select: { id: true }, orderBy: { id: "asc" } });
  const product = { name: "Fixture charging stand", description: "A protective charging stand.", brand: "Fixture",
    departmentId: category.id, specifications: [], keywords: [], addedOn: new Date(), position: 50 };
  try {
    await db.marketplaceShop.upsert({ where: { id: storeShop.id }, update: {},
      create: { ...storeShop, published: true, announcement: "", about: "" } });
    await db.product.create({ data: { ...product, id: sourceProductId, slug: sourceProductId, publication: "ARCHIVED", active: false } });
    await db.product.create({ data: { ...product, id: productId, slug: productId, foundation: true, publication: "ACTIVE",
      images: { create: [image] },
      translations: { create: { locale: "en-US", name: "Fixture charging station", description: "A protective charging station." } },
      optionDefinitions: { create: { id: "size", key: "size", label: "Size", position: 0,
        values: { create: sizes.map((label, position) => ({ id: `size-${position}`, value: label, label, position })) },
      } },
    } });
    for (const [position, id] of variantIds.entries()) {
      await db.variant.create({ data: { id, productId, sku: id.toUpperCase(), label: sizes[position], position,
        options: {}, optionSignature: JSON.stringify([["size", `size-${position}`]]), isDefault: position === 0 } });
      await db.variantOptionSelection.create({ data: { variantId: id, productId, optionId: "size", optionValueId: `size-${position}` } });
      const marketId = position < 2 ? "us" : "bd";
      const offer = await db.marketOfferIdentity.create({ data: { variantId: id, marketId, sellerId: storeShop.id } });
      await db.marketOffer.create({ data: { variantId: id, marketId, offerId: offer.id, publication: "ACTIVE",
        currency: marketId === "us" ? "USD" : "BDT", amountMinor: 1900 + position * 100 } });
    }
    await db.catalogMigrationRedirect.create({ data: { slug: sourceProductId, productId, sourceProductId } });

    const market = "market=us&lang=en-US";
    const path = (id: string, variant: string) => `/products/${id}?${market}&variant=${variant}`;
    for (const variant of [variantIds[0], variantIds[2]]) {
      const response = await page.request.get(path(sourceProductId, variant), { maxRedirects: 0 });
      expect(response.status()).toBe(308);
      expect(response.headers()["x-robots-tag"]).toContain("noindex");
      const destination = new URL(response.headers().location, baseURL);
      expect(destination.pathname).toBe(`/products/${productId}`);
      expect(destination.searchParams.get("variant")).toBe(variant);
      expect(destination.searchParams.get("market")).toBe("us");
      expect(destination.searchParams.get("lang")).toBe("en-US");
      const landing = await page.goto(destination.href);
      expect(landing?.headers()["x-robots-tag"]).toContain("noindex");
      await expect(page.getByRole("heading", { level: 1, name: "Fixture charging station" })).toBeVisible();
    }
    await expect(page.getByRole("status").filter({ hasText: /This variant is unavailable in United States/ })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Small", exact: true })).not.toBeChecked();

    await page.goto(path(productId, variantIds[0]));
    await expect(page.getByRole("radio", { name: "Small", exact: true })).toBeChecked();
    const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
    const structured = scripts.flatMap(source => {
      const data = JSON.parse(source);
      return data["@graph"] ?? [data];
    });
    const group = structured.find(item => item["@type"] === "ProductGroup");
    expect(group?.hasVariant.map((variant: { sku: string }) => variant.sku)).toEqual(variantIds.slice(0, 2).map(id => id.toUpperCase()));
    expect(group.hasVariant[0].offers).toMatchObject({ priceCurrency: "USD", price: expect.stringMatching(/^19(?:\.00)?$/) });
    expect(new URL(group.hasVariant[0].offers.url).searchParams.get("variant")).toBe(variantIds[0]);

    const api = `/api/catalog/search?${market}&limit=1`;
    const first = await page.request.get(api);
    expect(first.ok()).toBe(true);
    const cursorPage = await first.json();
    expect(cursorPage.nextCursor).toEqual(expect.any(String));
    const next = await page.request.get(`${api}&cursor=${cursorPage.nextCursor}`);
    const numbered = await page.request.get(`${api}&page=2`);
    expect(next.ok()).toBe(true);
    expect(numbered.ok()).toBe(true);
    expect((await next.json()).items.map((card: { id: string }) => card.id))
      .toEqual((await numbered.json()).items.map((card: { id: string }) => card.id));
    expect((await page.request.get(`${api}&page=2&cursor=${cursorPage.nextCursor}`)).status()).toBe(400);
    expect((await page.request.get(`/api/catalog/search?market=bd&lang=en-BD&limit=1&cursor=${cursorPage.nextCursor}`)).status()).toBe(400);

    const search = await page.request.get(`/search?q=${variantIds[0]}&${market}`);
    expect(search.headers()["x-robots-tag"]).toContain("noindex");
    const robots = await page.request.get("/robots.txt");
    expect(await robots.text()).toMatch(/Disallow: \/(?:\r?\n|$)/);
    const sitemap = await page.request.get("/sitemap.xml");
    expect(await sitemap.text()).not.toContain("<loc>");
  } finally {
    await db.catalogMigrationRedirect.deleteMany({ where: { slug: sourceProductId } });
    await db.marketOffer.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.marketOfferIdentity.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.variantOptionSelection.deleteMany({ where: { variantId: { in: variantIds } } });
    await db.variant.deleteMany({ where: { id: { in: variantIds } } });
    await db.product.deleteMany({ where: { id: { in: [productId, sourceProductId] } } });
    await db.$disconnect();
  }
});
