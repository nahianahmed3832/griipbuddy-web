import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { formatMoney, markets } from "../src/config/markets";
import type { listConnectedCatalog } from "../src/lib/catalog/connected-listing";
import { getDb } from "../src/lib/db/client";
import { requireLocalDatabase } from "../src/lib/db/local";
import { storeShop } from "../src/lib/marketplace/constants";

const image = { src: "/catalog/phone-stand.webp", alt: "Fixture category photograph" };
const blue = { src: "/catalog/headphones-taupe.webp", alt: "Blue fixture case" };
const black = { src: "/catalog/headphones-black.webp", alt: "Black fixture case" };
type Listing = Awaited<ReturnType<typeof listConnectedCatalog>>;

test("managed category navigation, physical filters and market prices use the persisted catalog", async ({ page, baseURL }, info) => {
  test.skip(process.env.GRIIP_CATALOG_STAGE9_BROWSER !== "1", "Use the disposable Stage 9 fixture profile.");
  requireLocalDatabase("griipbuddy_test");
  if (process.env.GRIIPBUDDY_ENV_FILE !== ".env.test" || !baseURL ||
      new URL(baseURL).hostname !== "127.0.0.1" || new URL(baseURL).origin !== process.env.BETTER_AUTH_URL ||
      !process.env.TEST_OWNER_PASSWORD) throw new Error("The catalog browser check requires isolated loopback fixtures.");

  test.setTimeout(125_000);
  page.setDefaultTimeout(10_000);
  const origin = new URL(baseURL).origin;
  const headers = { origin };
  await page.context().route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const staff = await page.context().browser()!.newContext({ baseURL });
  await staff.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const prefix = `stage9-${randomUUID().slice(0, 8)}`;
  const branch = `${prefix}-cases`;
  const leaf = `${prefix}-protective`;
  const alternate = `${prefix}-travel`;
  const collection = `${prefix}-collection`;
  const warehouse = `${prefix}-warehouse`;
  const usMethod = `${prefix}-ground`;
  const productId = `${prefix}-physical-case`;
  const productName = `Ridge Fixture Protective Case ${prefix}`;
  const brand = `Ridge Fixture ${prefix}`;
  const path = (id: string) => `/departments/${id}`;
  const menuLabel = "Browse fixture gear";
  const cases = ["a-plain", "a-floral", "b-floral"];
  const variants = cases.map(key => `v-${productId}-${key}`);
  const capacityId = `${prefix}-capacity`;
  const db = getDb();
  const usPolicy = await db.checkoutPolicy.findUniqueOrThrow({ where: { marketId: "us" },
    select: { enabled: true, codEnabled: true, taxTreatment: true, taxBasisPoints: true, taxLabel: true } });
  let menuRevision = (await db.marketMenu.findUnique({ where: { marketId_key_locale: { marketId: "bd", key: "main", locale: "" } } }))?.revision ?? null;
  const login = await staff.request.post("/api/staff/sign-in", { headers, data: { email: "owner@example.test", password: process.env.TEST_OWNER_PASSWORD } });
  expect(login.status()).toBe(200);

  async function write(action: string, input: object) {
    const result = await staff.request.post("/api/staff/catalog", { headers, data: { action, input } });
    expect(result.status(), await result.text()).toBe(200);
    return (await result.json()).data;
  }
  async function staffMarket(marketId: "bd" | "us") {
    const response = await staff.request.post("/api/staff/catalog/context", { headers, data: { marketId, permission: "commercial" } });
    expect(response.status()).toBe(200);
  }
  async function editMenu(label: string) {
    const saved = await write("menu.save", { marketId: "bd", key: "main", expectedRevision: menuRevision, items: [
      { type: "page", page: "SHOP", label: "Shop all" }, { type: "category", categoryId: prefix, label },
      { type: "collection", collectionId: collection }, { type: "category", categoryId: alternate, label: "Travel fixtures" },
    ] });
    menuRevision = saved.revision;
  }

  try {
    await db.checkoutPolicy.update({ where: { marketId: "us" }, data: {
      enabled: true, codEnabled: true, taxTreatment: "MERCHANDISE_RATE", taxBasisPoints: 500, taxLabel: "Fixture tax",
    } });
    await db.deliveryZone.createMany({ data: [
      { marketId: "us", district: "wa", districtLabel: "Washington", method: usMethod, label: "Fixture ground", chargeMinor: 350 },
      { marketId: "us", district: "ca", districtLabel: "California", method: usMethod, label: "Fixture ground", chargeMinor: 350 },
    ] });
    await db.dispatchLocation.create({ data: { id: warehouse, name: "Fixture catalog dispatch", marketId: "bd" } });
    for (const [id, parentId, kind, name] of [[prefix, null, "DEPARTMENT", "Fixture device gear"],
      [branch, prefix, "CATEGORY", "Fixture cases"], [leaf, branch, "SUBCATEGORY", "Protective fixtures"],
      [alternate, branch, "SUBCATEGORY", "Travel fixtures"]] as const) {
      await write("category.save", { id, parentId, kind, name, shortName: name, slug: id, revision: null, position: 20,
        description: "Two markets share this fixture category tree.", state: "ACTIVE", image, ...(id === prefix && { banner: image }) });
    }
    await write("category.translation", { id: leaf, revision: 0, locale: "en-US", translation: {
      name: "US Protective Fixtures", shortName: "US Protective Fixtures", description: "Case options sold in the United States.", slug: `${leaf}-us`,
    } });
    await write("category.translation", { id: leaf, revision: 1, locale: "bn-BD", translation: {
      name: "বাংলা ফিক্সচার কেস", shortName: "বাংলা কেস", description: "পরীক্ষার ক্যাটালগ", slug: `${leaf}-bn`,
    } });
    const attributeId = `${prefix}-grip`;
    await write("attribute.save", { id: attributeId, name: "Raised grip", scope: "PRODUCT", dataType: "BOOLEAN" });
    await write("category.attribute", { departmentId: branch, attributeId, expectedRevision: 0,
      template: { position: 1, filterable: true, required: false, inheritable: true } });
    await write("attribute.save", { id: capacityId, name: "Capacity (mL)", scope: "PRODUCT", dataType: "NUMBER" });
    await write("category.attribute", { departmentId: branch, attributeId: capacityId, expectedRevision: 1,
      template: { position: 2, filterable: true, required: false, inheritable: true } });
    const option = (key: string, labels: string[]) => ({ id: key, key, label: key,
      values: labels.map(label => ({ id: label.toLowerCase().replaceAll(" ", "-"), value: label, label })) });
    await write("product.save", { id: productId, slug: productId, name: productName, brand,
      primaryCategoryId: leaf, secondaryCategoryIds: [alternate], expectedRevision: null,
      description: "A persisted protective case with three physical model and design combinations.", publication: "DRAFT",
      attributeValues: { [attributeId]: true, [capacityId]: 500 }, options: [option("model", ["Phone A", "Phone B"]),
        option("design", ["Plain", "Floral"]), option("colour", ["Blue", "Black"])],
      variants: [["phone-a", "plain", "blue"], ["phone-a", "floral", "blue"], ["phone-b", "floral", "black"]].map(([model, design, colour], index) => ({
        id: variants[index], sku: `${prefix}-${cases[index]}`.toUpperCase(), selections: { model, design, colour },
      })), defaultVariantId: variants[0],
    });
    let revision = (await write("product.gallery", { productId, revision: 0, images: [image] })).revision;
    for (const [variantId, photo] of [[variants[0], blue], [variants[2], black]] as const) {
      revision = (await write("product.gallery", { productId, variantId, revision, images: [photo] })).revision;
    }
    await staffMarket("bd");
    await write("inventory.route", { productId, locationId: warehouse, marketId: "bd", active: true, priority: 0,
      districts: ["dhaka"], methods: ["standard"], expected: null });
    for (const [index, variantId] of variants.entries()) {
      const scope = { productId, marketId: "bd" };
      const pool = await write("inventory.initialize", { ...scope, variantId, locationId: warehouse });
      if (index !== 1) await write("inventory.movement", { ...scope, poolId: pool.id, expectedUpdatedAt: pool.updatedAt,
        kind: "RECEIPT", quantity: 4, idempotencyKey: variantId, reason: "Synthetic fixture receipt", reference: prefix });
    }
    await staffMarket("us");
    await write("inventory.route", { productId, locationId: warehouse, marketId: "us", active: true, priority: 0,
      districts: ["wa"], methods: [usMethod], expected: null });
    const offer = (variantId: string, marketId: "bd" | "us", amountMinor: number, salePriceMinor?: number) =>
      write("offer.configure", { variantId, marketId, sellerId: storeShop.id, currency: markets[marketId].currency,
        expectedRevision: null, amountMinor, publication: "ACTIVE", eligible: true, ...(salePriceMinor && {
          salePriceMinor, saleStartsAt: new Date(Date.now() - 60 * 60_000).toISOString(),
          saleEndsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        }),
      });
    await offer(variants[0], "us", 2499);
    await offer(variants[2], "us", 2899);
    await staffMarket("bd");
    await offer(variants[0], "bd", 129900);
    await offer(variants[1], "bd", 139900);
    const blackBdOffer = await offer(variants[2], "bd", 159900, 149900);
    await write("product.publish", { productId, revision });
    const created = await write("collection.save", { id: collection, slug: collection, expectedRevision: null, name: "Fixture travel edit",
      description: "A curated case to take on the go.", image, position: 8, selection: "CURATED" });
    const membership = await write("collection.products", { collectionId: collection, expectedRevision: created.revision,
      expectedProductIds: [], productIds: [productId] });
    await write("collection.publish", { collectionId: collection, marketId: "bd", expectedRevision: membership.revision, published: true });
    await editMenu(menuLabel);

    const padding = Array.from({ length: 24 }, (_, index) => ({ id: `${prefix}-page-${index}`, index }));
    const simple = padding[1];
    const simpleVariant = `v-${simple.id}`;
    const simpleModels = ["Fixture Phone Mini", "Fixture Phone Max"].map((name, index) => ({
      id: `${prefix}-universal-${index}`, name,
    }));
    await write("product.save", { id: simple.id, slug: simple.id, name: "Catalog fixture accessory 01",
      description: "A single-variant catalog accessory.", primaryCategoryId: alternate, expectedRevision: null,
      publication: "DRAFT", attributeValues: { [capacityId]: 750 }, options: [],
      variants: [{ id: simpleVariant, sku: simple.id.toUpperCase(), selections: {} }],
    });
    const simpleGallery = await write("product.gallery", { productId: simple.id, revision: 0, images: [image] });
    for (const model of simpleModels) await write("device.save", { ...model, brand, revision: null, aliases: [] });
    const compatible = await write("variant.compatibility", { productId: simple.id, variantId: simpleVariant,
      revision: simpleGallery.revision, modelIds: simpleModels.map(model => model.id) });
    const simplePool = await write("inventory.initialize", { productId: simple.id, marketId: "bd", variantId: simpleVariant,
      locationId: warehouse });
    await write("inventory.movement", { productId: simple.id, marketId: "bd", poolId: simplePool.id,
      expectedUpdatedAt: simplePool.updatedAt, kind: "RECEIPT", quantity: 2, idempotencyKey: simpleVariant,
      reason: "Synthetic universal accessory receipt", reference: prefix });
    const simpleOffer = await offer(simpleVariant, "bd", 29100);
    await write("product.publish", { productId: simple.id, revision: compatible.revision });

    const accessories = padding.filter(({ index }) => index !== simple.index);
    await db.$transaction(async tx => {
      await tx.product.createMany({ data: accessories.map(({ id, index }) => ({
        id, slug: id, departmentId: alternate, name: `Catalog fixture accessory ${index.toString().padStart(2, "0")}`,
        description: "Persisted catalog item for pagination.", keywords: [], specifications: [], attributeValues: { [capacityId]: 750 },
        addedOn: new Date("2026-11-01"), position: 10100 + index, publication: "ACTIVE",
      })) });
      await tx.variant.createMany({ data: accessories.map(({ id, index }) => ({
        id: `v-${id}`, productId: id, sku: id.toUpperCase(), label: "Standard",
        options: { Size: index % 2 ? "Small" : "Medium", ...(index > 1 && { Model: `Accessory model ${index}` }) },
        imageSrc: image.src, imageAlt: image.alt, position: 0,
      })) });
      await tx.marketOffer.createMany({ data: accessories.map(({ id, index }) => ({
        variantId: `v-${id}`, marketId: "bd", currency: "BDT", amountMinor: 29000 + index * 100, eligible: true,
      })) });
      const models = ["Accessory model 00", "Accessory model 01"].map((name, index) => ({
        id: `${prefix}-model-${index}`, name, lookupKey: `${prefix} ${name}`, brand: "Catalog fixture devices",
      }));
      await tx.deviceModel.createMany({ data: models });
      await tx.variantCompatibility.createMany({ data: models.map(({ id }) => ({
        variantId: `v-${padding[0].id}`, modelId: id,
      })) });
    });

    async function menu() {
      const bar = page.getByRole("navigation", { name: "Shop navigation", exact: true });
      if (await bar.isVisible()) return bar;
      const mobile = page.locator('summary[aria-label="Categories"]:visible');
      await mobile.focus();
      await mobile.press("Enter");
      return page.getByRole("navigation", { name: "Browse categories", exact: true });
    }
    const heading = (name: string) => page.getByRole("heading", { name, exact: true });
    const results = page.getByRole("region", { name: "Products", exact: true });
    const product = results.getByRole("link", { name: new RegExp(productName) });
    const filtersTrigger = page.getByRole("button", { name: "Filters", exact: true });
    const filters = async () => {
      if (await filtersTrigger.isVisible()) {
        await filtersTrigger.click();
        return page.getByRole("dialog", { name: "Filters", exact: true });
      }
      return page.getByRole("complementary", { name: "Filters", exact: true });
    };
    const resultNames = () => results.locator(".product-card h3");
    const getListing = (filters: Record<string, string>) =>
      page.request.get(`/api/catalog/products?${new URLSearchParams({ market: "bd", lang: "en-BD", ...filters })}`);
    async function listing(filters: Record<string, string>): Promise<Listing> {
      const response = await getListing(filters);
      expect(response.status(), await response.text()).toBe(200);
      return response.json();
    }
    const first = await listing({ category: prefix });
    const second = await listing({ category: prefix, cursor: first.nextCursor! });
    expect(first).toMatchObject({ currency: "BDT", total: 25, categoryId: prefix, nextCursor: expect.any(String) });
    expect(second).toMatchObject({ total: 25, currency: "BDT", nextCursor: null });
    const grouped = [...first.items, ...second.items];
    expect(new Set(grouped.map(item => item.id)).size).toBe(25);
    expect(grouped.find(({ id }) => id === productId)).toMatchObject({
      primaryCategoryId: leaf, secondaryCategoryIds: [alternate], matchingVariantIds: variants,
      matchedVariantId: null, fromPrice: { currency: "BDT", amountMinor: 129900, maxAmountMinor: 149900 },
    });
    expect(grouped.find(({ id }) => id === simple.id)).toMatchObject({
      matchingVariantIds: [simpleVariant], matchedVariantId: simpleVariant,
      representative: { options: [], offer: expect.objectContaining({ eligible: true, amountMinor: 29100 }) },
    });
    expect(first.facets.model).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Phone A", count: 1 }), expect.objectContaining({ label: "Accessory model 23", count: 1 }),
    ]));
    expect(first.facets.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: capacityId, dataType: "NUMBER",
        values: [expect.objectContaining({ value: 500, count: 1 }), expect.objectContaining({ value: 750, count: 24 })] }),
    ]));
    const wrongScope = await getListing({ category: prefix, sort: "name", cursor: first.nextCursor! });
    expect(wrongScope.status()).toBe(400);
    expect(await wrongScope.json()).toMatchObject({ error: { code: "invalid_cursor" } });
    const us = await listing({ category: prefix, market: "us", lang: "en-US" });
    expect(us).toMatchObject({ currency: "USD", total: 1, items: [
      expect.objectContaining({ id: productId, matchingVariantIds: [variants[0], variants[2]],
        fromPrice: { currency: "USD", amountMinor: 2499, maxAmountMinor: 2899 } }),
    ] });
    const universal = await listing({ category: prefix, model: `${prefix}-model-1`, option: "size:Medium" });
    expect(universal).toMatchObject({ total: 1, items: [
      expect.objectContaining({ id: padding[0].id, matchingVariantIds: [`v-${padding[0].id}`],
        matchedVariantId: `v-${padding[0].id}` }),
    ] });
    const delivery = { country: "BD", district: "dhaka", method: "standard", paymentMethod: "COD" };
    const oneOffer = { ...delivery, category: leaf, model: "Phone A", color: "blue", minMinor: "139900" };
    expect((await listing({ ...oneOffer, availability: "available" })).total).toBe(0);
    expect(await listing({ ...oneOffer, availability: "out_of_stock" })).toMatchObject({ total: 1, items: [
      expect.objectContaining({ matchedVariantId: variants[1], representative: expect.objectContaining({
        availability: "out_of_stock", image, offer: expect.objectContaining({ amountMinor: 139900, currency: "BDT" }),
      }) }),
    ] });

    await page.goto("/?market=bd");
    const mainMenu = await menu();
    const departmentLink = mainMenu.getByRole("link", { name: menuLabel, exact: true });
    await expect(departmentLink).toBeVisible();
    await departmentLink.focus();
    await departmentLink.press("Enter");
    await expect(heading("Fixture device gear")).toBeVisible();
    await expect(heading("Shop by category")).toBeVisible();
    await expect(heading("Collections to explore")).toBeVisible();
    await expect(product).toHaveCount(1);
    await expect(results.getByText("25 products", { exact: true })).toBeVisible();
    await expect(resultNames()).toHaveText(first.items.map(({ name }) => name));
    await expect(product.locator(".product-card__price")).toHaveText(/From\s*৳1,299/);
    const nextPage = results.getByRole("link", { name: "Next page" });
    await expect(nextPage).toHaveAttribute("rel", "next");
    await nextPage.click();
    await expect(page).toHaveURL(/page=2/);
    await expect(results.getByText("Page 2 of 2")).toBeVisible();
    await expect(resultNames()).toHaveText(second.items.map(({ name }) => name));
    await page.reload();
    await expect(results.getByText("Page 2 of 2")).toBeVisible();
    await results.getByRole("link", { name: "Previous page" }).click();
    await expect(product).toHaveCount(1);
    await page.goBack();
    await expect(results.getByText("Page 2 of 2")).toBeVisible();
    await page.goForward();
    await expect(results.getByText("Page 1 of 2")).toBeVisible();
    await results.getByRole("combobox", { name: "Sort by" }).selectOption("price-low");
    await results.getByRole("button", { name: "Apply sort" }).click();
    await expect(page).toHaveURL(/sort=price-low/);
    await expect(results.getByRole("heading", { name: "Catalog fixture accessory 00" })).toBeVisible();
    await expect(resultNames()).toHaveText((await listing({ category: prefix, sort: "price-low" })).items.map(({ name }) => name));

    await test.step("find values outside the current page and keep mobile filter drafts", async () => {
      await results.getByRole("link", { name: "Next page" }).click();
      await expect(results.getByText("Page 2 of 2")).toBeVisible();
      const pagedUrl = page.url();
      const mobileFilters = await filtersTrigger.isVisible();
      let panel = await filters();
      const searchModel = () => panel.getByRole("searchbox", { name: "Search device or model" });
      const model = () => panel.getByRole("checkbox", { name: "Accessory model 23", exact: true });
      const capacity = panel.getByRole("group", { name: "Capacity (mL)", exact: true });
      await expect(capacity.getByRole("checkbox", { name: "750", exact: true })).toHaveAccessibleDescription("24 products");
      await searchModel().fill("Accessory model 23");
      await expect(model()).toHaveAccessibleDescription("1 product");
      await model().check();
      await searchModel().fill("Phone A");
      await expect(model()).toBeHidden();
      if (mobileFilters) {
        await panel.getByRole("button", { name: "Close filters" }).click();
        await expect(filtersTrigger).toBeFocused();
        await expect(page).toHaveURL(pagedUrl);
        panel = await filters();
        await searchModel().fill("Accessory model 23");
        await expect(model()).toBeChecked();
      }
      await panel.getByRole("button", { name: "Apply filters" }).click();
      await expect(page).toHaveURL(url => url.searchParams.get("sort") === "price-low" && url.searchParams.has("model") &&
        !url.searchParams.has("page"));
      await expect(resultNames()).toHaveText(["Catalog fixture accessory 23"]);
      if (mobileFilters) {
        const appliedUrl = page.url();
        panel = await filters();
        await searchModel().fill("Accessory model 23");
        await expect(model()).toBeChecked();
        await panel.getByRole("button", { name: "Reset filters" }).click();
        await searchModel().fill("Accessory model 23");
        await expect(model()).not.toBeChecked();
        await expect(page).toHaveURL(appliedUrl);
        await panel.getByRole("button", { name: "Apply filters" }).click();
      } else await results.getByRole("link", { name: "Clear all", exact: true }).click();
      await expect(results.getByText("25 products", { exact: true })).toBeVisible();
    });

    await page.goto(`${path(branch)}?market=bd`);
    await expect(heading("Subcategories")).toBeVisible();
    await page.getByRole("link", { name: /Protective fixtures/i }).filter({ has: page.locator(".collection-card__name") }).click();
    await expect(heading("Protective fixtures")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Fixture cases" })).toBeVisible();
    let panel = await filters();
    await expect(panel.getByRole("group", { name: "Raised grip" })).toBeVisible();
    const minimum = panel.getByRole("textbox", { name: "Minimum price in BDT", exact: true });
    const maximum = panel.getByRole("textbox", { name: "Maximum price in BDT", exact: true });
    await minimum.fill("1500");
    await maximum.fill("900");
    await panel.getByRole("button", { name: "Apply filters" }).click();
    await expect(panel.getByRole("alert")).toHaveText(/Minimum price must be less than or equal to maximum price/);
    await expect(maximum).toBeFocused();
    await minimum.clear();
    await maximum.clear();
    await panel.getByRole("checkbox", { name: "Phone B", exact: true }).check();
    await panel.getByRole("checkbox", { name: "Blue", exact: true }).check();
    await panel.getByRole("button", { name: "Apply filters" }).click();
    await expect(heading("No products match these filters")).toBeVisible();
    await page.reload();
    await expect(heading("No products match these filters")).toBeVisible();
    panel = await filters();
    await expect(panel.getByRole("checkbox", { name: "Phone A", exact: true })).toHaveAccessibleDescription("1 product");
    await expect(panel.getByRole("checkbox", { name: "Phone B", exact: true })).toHaveAccessibleDescription("0 products");
    await expect(panel.getByRole("checkbox", { name: "Black", exact: true })).toHaveAccessibleDescription("1 product");
    await expect(panel.getByRole("checkbox", { name: "Blue", exact: true })).toHaveAccessibleDescription("0 products");
    if (await filtersTrigger.isVisible()) await panel.getByRole("button", { name: "Close filters" }).click();
    await results.getByRole("link", { name: "Remove Device or model: Phone B" }).click();
    await expect(product).toHaveCount(1);
    let selected = new URL((await product.getAttribute("href"))!, origin);
    expect(selected.searchParams.getAll("option")).toContain("colour:blue");
    expect(selected.searchParams.get("variant")).toBeNull();
    await product.click();
    await expect(page.getByText(/Matching options.*Blue/)).toBeVisible();
    await expect(page.getByRole("group", { name: /^design$/i }).getByRole("radio")).toHaveCount(2);
    await expect(page.getByRole("radio", { name: "Blue", exact: true })).toBeChecked();
    await expect(page.getByRole("button", { name: "Add to cart" })).toBeDisabled();
    await page.goBack();
    panel = await filters();
    await panel.getByRole("checkbox", { name: "Plain", exact: true }).check();
    await panel.getByRole("button", { name: "Apply filters" }).click();
    await expect(page).toHaveURL(/design=plain/);
    await expect(product.getByRole("img", { name: blue.alt })).toBeVisible();
    await expect(product.getByText("৳1,299", { exact: true })).toBeVisible();
    await expect(product).toHaveAttribute("href", new RegExp(`variant=${variants[0]}`));
    selected = new URL((await product.getAttribute("href"))!, origin);
    expect(selected.searchParams.get("variant")).toBe(variants[0]);
    expect(selected.searchParams.get("category")).toBe(leaf);
    await product.click();
    await expect(page.getByRole("radio", { name: "Phone A", exact: true })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Plain", exact: true })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Blue", exact: true })).toBeChecked();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Protective fixtures" })).toBeVisible();
    const otherModel = page.getByRole("radio", { name: "Phone B", exact: true });
    await otherModel.focus();
    await page.keyboard.press("Space");
    await expect(otherModel).toBeChecked();
    await expect(page.getByRole("radio", { name: "Plain", exact: true })).not.toBeChecked();
    await expect(page.getByRole("radio", { name: "Blue", exact: true })).not.toBeChecked();
    await expect(page.getByRole("button", { name: "Add to cart" })).toBeDisabled();
    await expect(page).toHaveURL(/option=model%3Aphone-b/);
    await page.goBack();
    await expect(page.getByRole("radio", { name: "Phone A", exact: true })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Blue", exact: true })).toBeChecked();

    await test.step("normalize obsolete values and keep the latest filter navigation", async () => {
      const leafUrl = path(leaf);
      await page.goto(`${leafUrl}?market=bd&lang=en-BD&model=discontinued-fixture-model&color=black&sort=price-high&page=999`);
      await expect(results.getByRole("status").filter({ hasText: /selections were removed.*Device or model/ })).toBeVisible();
      await expect(page).toHaveURL(url => !url.searchParams.has("model") && !url.searchParams.has("page") &&
        url.searchParams.get("color") === "black" && url.searchParams.get("sort") === "price-high");
      await expect(product.locator(".product-card__price data")).toHaveAttribute("value", "149900");
      await expect(product.locator(".product-card__price del")).toHaveText("৳1,599");

      await page.goto(`${leafUrl}?market=bd&lang=en-BD&model=Phone+B&color=blue`);
      await expect(heading("No products match these filters")).toBeVisible();
      const removeModel = results.getByRole("link", { name: "Remove Device or model: Phone B", exact: true });
      const removeColour = results.getByRole("link", { name: "Remove Colour: Blue", exact: true });
      const olderHref = new URL((await removeModel.getAttribute("href"))!, origin);
      const latestHref = new URL((await removeColour.getAttribute("href"))!, origin);
      olderHref.searchParams.sort();
      const oldRequest = (url: URL) => {
        const actual = new URL(url);
        actual.searchParams.delete("_rsc");
        actual.searchParams.sort();
        return actual.href === olderHref.href;
      };
      let olderResponse: { status: number; contentType: string | undefined } | undefined;
      let release = () => {};
      let finish = () => {};
      const hold = new Promise<void>(resolve => { release = resolve; });
      const delivered = new Promise<void>(resolve => { finish = resolve; });
      await page.route(oldRequest, async route => {
        if (route.request().headers().rsc !== "1") return route.continue();
        try {
          const response = await route.fetch({ maxRedirects: 0 });
          olderResponse = { status: response.status(), contentType: response.headers()["content-type"] };
          await hold;
          await route.fulfill({ response }).catch(() => {});
        } finally {
          finish();
        }
      });
      try {
        await removeModel.click();
        await expect.poll(() => olderResponse).toEqual({ status: 200, contentType: expect.stringContaining("text/x-component") });
        await removeColour.click();
        await expect(page).toHaveURL(latestHref.href);
        await expect(product.getByRole("img", { name: black.alt })).toBeVisible();
      } finally {
        release();
        if (olderResponse) await delivered;
        await page.unroute(oldRequest);
      }
      await expect(page).toHaveURL(latestHref.href);
      await expect(results.getByText("1 product", { exact: true })).toBeVisible();
      await expect(product).toHaveAttribute("href", new RegExp(`variant=${variants[2]}`));
    });

    const stockFilters = new URLSearchParams({ ...delivery, market: "bd", lang: "en-BD",
      model: "Phone A", color: "blue", minMinor: "139900", priceCurrency: "BDT", availability: "out_of_stock" });
    await page.goto(`${path(leaf)}?${stockFilters}`);
    await expect(product.getByText("Out of stock", { exact: true })).toBeVisible();
    await expect(product.getByRole("img", { name: image.alt })).toBeVisible();
    await expect(product.locator(".product-card__price data")).toHaveAttribute("value", "139900");

    async function preferences(change: { region?: "bd" | "us"; language?: string }) {
      await page.getByRole("button", { name: /^Shopping preferences,/ }).click();
      const dialog = page.getByRole("dialog", { name: "Update your settings" });
      if (change.region) await dialog.getByRole("combobox", { name: "Region", exact: true }).selectOption(change.region);
      if (change.language) await dialog.getByRole("combobox", { name: "Language", exact: true }).selectOption(change.language);
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
    }
    const shopFixture = new URLSearchParams({ market: "bd", lang: "en-BD", brand, model: "Phone B", color: "blue" });
    await page.goto(`/shop?${shopFixture}`);
    await expect(heading("Shop all")).toBeVisible();
    await expect(heading("No products match these filters")).toBeVisible();
    shopFixture.set("color", "black");
    await page.goto(`/shop?${shopFixture}`);
    await expect(product).toHaveCount(1);
    await expect(product.getByRole("img", { name: black.alt })).toBeVisible();
    await expect(product.getByText("৳1,499", { exact: true })).toBeVisible();
    await expect(product).toHaveAttribute("href", new RegExp(`variant=${variants[2]}`));

    shopFixture.set("max", "1500");
    shopFixture.set("page", "2");
    await page.goto(`/shop?${shopFixture}`);
    await preferences({ region: "us" });
    await expect(product.getByText("$28.99", { exact: true })).toBeVisible();
    await expect(results.getByRole("status").filter({ hasText: /selections were removed.*Price/ })).toBeVisible();
    await expect(page).toHaveURL(url => !["min", "max", "minMinor", "maxMinor", "page", "browseFrom"]
      .some(key => url.searchParams.has(key)));
    expect((await page.request.get("/shop?market=us")).headers()["cache-control"]).toContain("no-store");
    await page.reload();
    await expect(product.getByText("$28.99", { exact: true })).toBeVisible();

    await page.goto(`/shop?market=us&department=${leaf}&model=Phone+B`);
    await expect(page).toHaveURL(url => url.pathname === path(`${leaf}-us`) && url.searchParams.has("model"));
    await expect(product.getByText("$28.99", { exact: true })).toBeVisible();

    await page.goto(`${path(leaf)}?market=bd&color=blue&design=plain`);
    await preferences({ language: "bn-BD" });
    await expect(heading("বাংলা ফিক্সচার কেস")).toBeVisible();
    await expect(product.getByText(formatMoney(129900, { ...markets.bd, locale: "bn-BD" }), { exact: true })).toBeVisible();
    await page.goto(`${path(leaf)}?market=bd&lang=en-BD&color=blue&design=plain&maxMinor=150000&priceCurrency=BDT&page=2`);
    await preferences({ region: "us" });
    await expect(heading("US Protective Fixtures")).toBeVisible();
    await expect(product.getByText("$24.99", { exact: true })).toBeVisible();
    await expect(results.getByRole("status").filter({ hasText: /selections were removed.*Price/ })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("page")).toBeNull();
    expect(new URL(page.url()).pathname).toBe(path(`${leaf}-us`));
    await page.reload();
    await expect(product.getByText("$24.99", { exact: true })).toBeVisible();
    const proof = process.env.GRIIP_CATEGORY_BROWSE_EVIDENCE;
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
    if (proof) {
      await mkdir(proof, { recursive: true });
      await page.locator(".connected-catalog:visible").evaluate(element => element.scrollIntoView());
      await page.screenshot({ path: join(proof, `browse-${info.project.name}.png`), animations: "disabled" });
    }

    await page.goto(`/collections/${collection}?market=bd&lang=en-BD&model=Phone+B&color=blue`);
    await expect(heading("Fixture travel edit")).toBeVisible();
    await expect(heading("No products match these filters")).toBeVisible();
    expect((await listing({ collection, model: "Phone B", color: "blue" })).total).toBe(0);
    await results.getByRole("link", { name: "Clear all", exact: true }).click();
    await expect(product).toHaveCount(1);
    await preferences({ region: "us" });
    await expect(page).toHaveURL(/\/shop\?[^#]*catalogUnavailable=collection/);
    await expect(page.getByRole("status").filter({ hasText: /That collection is unavailable in United States/ })).toBeVisible();
    await page.goto(`/collections/${collection}?market=us`);
    await expect(heading("Collection unavailable")).toBeVisible();

    await editMenu("New fixture menu title");
    await write("category.presentation", { id: alternate, revision: 0, marketId: "bd", presentation: { visibleInNavigation: false } });
    await page.goto("/?market=bd&lang=en-BD");
    const updatedMenu = await menu();
    await expect(updatedMenu.getByText("New fixture menu title", { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(updatedMenu.getByRole("link", { name: "Travel fixtures", exact: true })).toHaveCount(0);
    await page.goto(`${path(alternate)}?market=bd`);
    await expect(product).toHaveCount(1);
    expect((await page.request.get(`/api/catalog/products?market=us&category=${leaf}`)).headers()["cache-control"]).toContain("no-store");

    if (info.project.name === "desktop") {
      await db.$executeRawUnsafe('ALTER TABLE "Variant" RENAME TO "Stage9FixtureUnavailableVariant"');
      try {
        const unavailable = await getListing({ category: leaf });
        expect(unavailable.status()).toBe(503);
        expect(await unavailable.json()).toMatchObject({ error: { code: "catalog_unavailable" } });
        await page.goto(`${path(leaf)}?market=bd&lang=en-BD`);
        await expect(heading("We couldn’t load this catalog page")).toBeVisible();
      } finally {
        await db.$executeRawUnsafe('ALTER TABLE "Stage9FixtureUnavailableVariant" RENAME TO "Variant"');
      }
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await expect(product).toHaveCount(1);
    }
    await test.step("show a default SKU with two fits, and retain a variant unavailable in the new market", async () => {
      const detailPath = (slug: string, market = "bd", extra = "") =>
        `/api/catalog/products/${slug}?market=${market}&lang=${market === "bd" ? "en-BD" : "en-US"}${extra}`;
      const simpleResponse = await page.request.get(detailPath(simple.id));
      expect(simpleResponse.status()).toBe(200);
      expect(await simpleResponse.json()).toMatchObject({ product: { id: simple.id }, options: [], variants: [
        expect.objectContaining({ id: simpleVariant, isDefault: true, options: [],
          compatibility: expect.arrayContaining(simpleModels.map(model => expect.objectContaining(model))) }),
      ] });
      const main = page.getByRole("main");
      const add = main.getByRole("button", { name: "Add to cart", exact: true });
      const gallery = main.getByRole("region", { name: "Product images", exact: true });
      const deliveryForm = main.getByRole("form", { name: "Check delivery", exact: true });
      const termsStatus = (text: string | RegExp) => main.getByRole("status").filter({ hasText: text });
      const price = main.locator(".product-detail__price:visible");
      await page.goto(`/products/${simple.id}?market=bd&lang=en-BD`);
      await expect(main.getByText(`SKU ${simple.id.toUpperCase()}`, { exact: true }).filter({ visible: true })).toBeVisible();
      await expect(main.getByRole("group", { name: "Product options", exact: true }).getByRole("radio")).toHaveCount(0);
      const compatibility = main.getByRole("region", { name: "Compatibility", exact: true });
      await expect(compatibility.getByRole("heading", { name: "Compatibility", exact: true })).toBeVisible();
      for (const { name } of simpleModels) await expect(compatibility.getByText(`${brand} ${name}`, { exact: true })).toBeVisible();
      await expect(gallery.getByRole("img", { name: image.alt, exact: true })).toBeVisible();
      await expect(price).toHaveText("৳291");
      await expect(add).toBeDisabled();
      await deliveryForm.getByRole("combobox", { name: "Delivery district", exact: true }).selectOption("dhaka");
      await deliveryForm.getByRole("combobox", { name: "Delivery service", exact: true }).selectOption("COD:standard");
      await deliveryForm.getByRole("button", { name: "Check delivery", exact: true }).click();
      await expect(termsStatus("Available for your delivery selection.")).toBeVisible();
      await expect(add).toBeEnabled();
      expect(await db.inventoryAllocation.count({ where: { offerId: simpleOffer.id } })).toBe(0);

      const sharedVariant = variants[0];
      await page.goto(`/products/${productId}?market=bd&lang=en-BD&variant=${sharedVariant}`);
      await preferences({ language: "bn-BD" });
      await expect(page).toHaveURL(new RegExp(`variant=${sharedVariant}`));
      await expect(price).toHaveText(formatMoney(129900, { ...markets.bd, locale: "bn-BD" }));
      await preferences({ region: "us" });
      await expect(page).toHaveURL(new RegExp(`variant=${sharedVariant}`));
      await expect(price).toHaveText("$24.99");
      await expect(gallery.getByRole("img", { name: blue.alt, exact: true })).toBeVisible();
      await deliveryForm.getByRole("combobox", { name: "State", exact: true }).selectOption("ca");
      await deliveryForm.getByRole("textbox", { name: "ZIP code", exact: true }).fill("90001");
      await deliveryForm.getByRole("combobox", { name: "Delivery service", exact: true }).selectOption(`COD:${usMethod}`);
      await deliveryForm.getByRole("button", { name: "Check delivery", exact: true }).click();
      await expect(termsStatus("This variant can’t be delivered using the selected service.")).toBeVisible();
      await expect(add).toBeDisabled();

      const missingOfferVariant = variants[1];
      await page.goto(`/products/${productId}?market=bd&lang=en-BD&variant=${missingOfferVariant}`);
      await expect(page.getByRole("radio", { name: "Phone A", exact: true })).toBeChecked();
      await expect(page.getByRole("radio", { name: "Floral", exact: true })).toBeChecked();
      await expect(gallery.getByRole("img", { name: image.alt, exact: true })).toBeVisible();
      await expect(price).toHaveText("৳1,399");
      await deliveryForm.getByRole("combobox", { name: "Delivery district", exact: true }).selectOption("dhaka");
      await deliveryForm.getByRole("combobox", { name: "Delivery service", exact: true }).selectOption("COD:standard");
      await deliveryForm.getByRole("button", { name: "Check delivery", exact: true }).click();
      await expect(termsStatus("Out of stock for this delivery.")).toBeVisible();
      await expect(add).toBeDisabled();

      await preferences({ region: "us" });
      await expect(termsStatus(/This variant is unavailable in United States/)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`variant=${missingOfferVariant}`));
      await expect(price).toHaveCount(0);
      await expect(add).toBeDisabled();
      const exact = await page.request.get(detailPath(productId, "us", `&variant=${missingOfferVariant}`));
      expect(exact.status()).toBe(200);
      expect(await exact.json()).toMatchObject({ selection: { status: "unavailable", requestedVariantId: missingOfferVariant } });
      await page.reload();
      await expect(termsStatus(/This variant is unavailable in United States/)).toBeVisible();
      await expect(price).toHaveCount(0);

      await db.variant.update({ where: { id: missingOfferVariant }, data: { active: false, archivedAt: new Date() } });
      await page.goto(`/products/${productId}?market=bd&lang=en-BD&variant=${missingOfferVariant}`);
      await expect(termsStatus("This variant has been archived.")).toBeVisible();
      await expect(price).toHaveCount(0);
      await expect(add).toBeDisabled();
    });
    await write("offer.configure", { variantId: variants[2], marketId: "bd", sellerId: storeShop.id, currency: "BDT",
      expectedRevision: blackBdOffer.revision, amountMinor: 159900, publication: "ACTIVE", eligible: false });
    await page.goto(`${path(leaf)}?market=bd&lang=en-BD&color=black`);
    await expect(product.getByText("Unavailable in this market", { exact: true })).toBeVisible();
    await expect(product.locator(".product-card__price data, .product-card__price del")).toHaveCount(0);
  } finally {
    await db.checkoutPolicy.update({ where: { marketId: "us" }, data: usPolicy });
    await db.deliveryZone.deleteMany({ where: { marketId: "us", method: usMethod } });
    await staff.close();
  }
});
