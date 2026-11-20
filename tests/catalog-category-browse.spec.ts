import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { formatMoney, markets } from "../src/config/markets";
import { getDb } from "../src/lib/db/client";
import { storeShop } from "../src/lib/marketplace/constants";

const image = { src: "/catalog/phone-stand.webp", alt: "Fixture category photograph" };
const blue = { src: "/catalog/headphones-taupe.webp", alt: "Blue fixture case" };
const black = { src: "/catalog/headphones-black.webp", alt: "Black fixture case" };

test("managed category navigation, physical filters and market prices use the persisted catalog", async ({ page, baseURL }, info) => {
  test.skip(process.env.GRIIP_CATALOG_STAGE9_BROWSER !== "1", "Use the disposable Stage 9 fixture profile.");
  const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  if (!baseURL || new URL(baseURL).hostname !== "127.0.0.1" || process.env.COMMERCE_MODE !== "local" ||
      database.hostname !== "127.0.0.1" || database.pathname !== "/griipbuddy_test" || database.search ||
      !process.env.TEST_OWNER_PASSWORD) throw new Error("The catalog browser check requires isolated loopback fixtures.");

  test.setTimeout(95_000);
  page.setDefaultTimeout(10_000);
  const origin = new URL(baseURL).origin;
  const headers = { origin };
  await page.context().route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const staff = await page.context().browser()!.newContext({ baseURL });
  const prefix = `stage9-${randomUUID().slice(0, 8)}`;
  const branch = `${prefix}-cases`;
  const leaf = `${prefix}-protective`;
  const alternate = `${prefix}-travel`;
  const collection = `${prefix}-collection`;
  const productId = `${prefix}-physical-case`;
  const productName = `Ridge Fixture Protective Case ${prefix}`;
  const brand = `Ridge Fixture ${prefix}`;
  const path = (id: string) => `/departments/${id}`;
  const menuLabel = "Browse fixture gear";
  const cases = ["a-plain", "a-floral", "b-floral"];
  const variants = cases.map(key => `v-${productId}-${key}`);
  const db = getDb();
  let menuRevision = (await db.marketMenu.findUnique({ where: { marketId_key_locale: { marketId: "bd", key: "main", locale: "" } } }))?.revision ?? null;
  const login = await staff.request.post("/api/staff/sign-in", { headers, data: { email: "owner@example.test", password: process.env.TEST_OWNER_PASSWORD } });
  expect(login.status()).toBe(200);

  async function write(action: string, input: object) {
    const result = await staff.request.post("/api/staff/catalog", { headers, data: { action, input } });
    expect(result.status(), await result.text()).toBe(200);
    return (await result.json()).data;
  }
  async function editMenu(label: string) {
    const saved = await write("menu.save", { marketId: "bd", key: "main", expectedRevision: menuRevision, items: [
      { type: "page", page: "SHOP", label: "Shop all" }, { type: "category", categoryId: prefix, label },
      { type: "collection", collectionId: collection }, { type: "category", categoryId: alternate, label: "Travel fixtures" },
    ] });
    menuRevision = saved.revision;
  }

  try {
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
    const option = (key: string, labels: string[]) => ({ id: key, key, label: key,
      values: labels.map(label => ({ id: label.toLowerCase().replaceAll(" ", "-"), value: label, label })) });
    await write("product.save", { id: productId, slug: productId, name: productName, brand,
      primaryCategoryId: leaf, secondaryCategoryIds: [alternate], expectedRevision: null,
      description: "A persisted protective case with three physical model and design combinations.", publication: "DRAFT",
      attributeValues: { [attributeId]: true }, options: [option("model", ["Phone A", "Phone B"]),
        option("design", ["Plain", "Floral"]), option("colour", ["Blue", "Black"])],
      variants: [["phone-a", "plain", "blue"], ["phone-a", "floral", "blue"], ["phone-b", "floral", "black"]].map(([model, design, colour], index) => ({
        id: variants[index], sku: `${prefix}-${cases[index]}`.toUpperCase(), selections: { model, design, colour },
      })), defaultVariantId: variants[0],
    });
    let revision = (await write("product.gallery", { productId, revision: 0, images: [image] })).revision;
    for (const [index, variantId] of variants.entries()) revision = (await write("product.gallery", { productId, variantId, revision,
      images: [index === 2 ? black : blue],
    })).revision;
    const offer = (variantId: string, marketId: "bd" | "us", amountMinor: number) => write("offer.configure", {
      variantId, marketId, sellerId: storeShop.id, currency: marketId === "bd" ? "BDT" : "USD",
      expectedRevision: null, amountMinor, publication: "ACTIVE", eligible: false,
    });
    for (const [index, variantId] of variants.entries()) await offer(variantId, "bd", 129900 + index * 10000);
    await write("product.publish", { productId, revision });
    const created = await write("collection.save", { id: collection, slug: collection, expectedRevision: null, name: "Fixture travel edit",
      description: "A curated case to take on the go.", image, position: 8, selection: "CURATED" });
    const membership = await write("collection.products", { collectionId: collection, expectedRevision: created.revision,
      expectedProductIds: [], productIds: [productId] });
    await write("collection.publish", { collectionId: collection, marketId: "bd", expectedRevision: membership.revision, published: true });
    await editMenu(menuLabel);
    const switched = await staff.request.post("/api/staff/catalog/context", { headers, data: { marketId: "us", permission: "commercial" } });
    expect(switched.status()).toBe(200);
    await offer(variants[0], "us", 2499);
    await offer(variants[2], "us", 2899);
    const switchedBack = await staff.request.post("/api/staff/catalog/context", { headers, data: { marketId: "bd", permission: "commercial" } });
    expect(switchedBack.status()).toBe(200);

    const padding = Array.from({ length: 24 }, (_, index) => ({ id: `${prefix}-page-${index}`, index }));
    await db.$transaction(async tx => {
      await tx.product.createMany({ data: padding.map(({ id, index }) => ({
        id, slug: id, departmentId: alternate, name: `Catalog fixture accessory ${index.toString().padStart(2, "0")}`,
        description: "Persisted catalog item for pagination.", keywords: [], specifications: [],
        addedOn: new Date("2026-11-01"), position: 10100 + index, publication: "ACTIVE",
      })) });
      await tx.variant.createMany({ data: padding.map(({ id }) => ({
        id: `v-${id}`, productId: id, sku: id.toUpperCase(), options: {}, label: "Standard",
        imageSrc: image.src, imageAlt: image.alt, position: 0,
      })) });
      await tx.marketOffer.createMany({ data: padding.map(({ id, index }) => ({
        variantId: `v-${id}`, marketId: "bd", currency: "BDT", amountMinor: 29000 + index * 100, eligible: true,
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

    await page.goto("/?market=bd");
    const mainMenu = await menu();
    const branchDisclosure = mainMenu.locator("summary").filter({ hasText: menuLabel });
    if (await branchDisclosure.isVisible()) await branchDisclosure.click();
    const departmentLink = mainMenu.getByRole("link", { name: /^(See all )?Browse fixture gear$/i });
    await expect(departmentLink).toBeVisible();
    await departmentLink.focus();
    await departmentLink.press("Enter");
    await expect(heading("Fixture device gear")).toBeVisible();
    await expect(heading("Shop by category")).toBeVisible();
    await expect(heading("Collections to explore")).toBeVisible();
    await expect(product).toHaveCount(1);
    await expect(results.getByText("25 products", { exact: true })).toBeVisible();
    await results.getByRole("link", { name: "Next page" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(results.getByText("Page 2 of 2")).toBeVisible();
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

    await page.goto(`${path(branch)}?market=bd`);
    await expect(heading("Subcategories")).toBeVisible();
    await page.getByRole("link", { name: /Protective fixtures/i }).filter({ has: page.locator(".collection-card__name") }).click();
    await expect(heading("Protective fixtures")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Fixture cases" })).toBeVisible();
    const filters = async () => {
      const trigger = page.getByRole("button", { name: "Filters", exact: true });
      if (await trigger.isVisible()) {
        await trigger.click();
        return page.getByRole("dialog", { name: "Filters", exact: true });
      }
      return page.getByRole("complementary", { name: "Filters", exact: true });
    };
    let panel = await filters();
    await expect(panel.getByRole("group", { name: "Raised grip" })).toBeVisible();
    await panel.getByRole("checkbox", { name: "Phone B", exact: true }).check();
    await panel.getByRole("checkbox", { name: "Blue", exact: true }).check();
    await panel.getByRole("button", { name: "Apply filters" }).click();
    await expect(heading("No products match these filters")).toBeVisible();
    await page.reload();
    await expect(heading("No products match these filters")).toBeVisible();
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

    await page.goto(`/collections/${collection}?market=bd`);
    await expect(heading("Fixture travel edit")).toBeVisible();
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
        await page.goto(`${path(leaf)}?market=bd&lang=en-BD`);
        await expect(heading("We couldn’t load this catalog page")).toBeVisible();
      } finally {
        await db.$executeRawUnsafe('ALTER TABLE "Stage9FixtureUnavailableVariant" RENAME TO "Variant"');
      }
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await expect(product).toHaveCount(1);
    }
  } finally {
    await staff.close();
  }
});
