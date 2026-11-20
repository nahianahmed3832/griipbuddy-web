import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { BrowserMeasurement } from "../src/lib/measurement/schema";

test("category browsing measures consenting visits, filters and the matched product click once", async ({ page, baseURL }) => {
  test.skip(process.env.GRIIP_CATALOG_STAGE9_BROWSER !== "1", "Use the disposable Stage 9 fixture profile.");
  const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  if (!baseURL || new URL(baseURL).hostname !== "127.0.0.1" || process.env.COMMERCE_MODE !== "local" ||
      database.hostname !== "127.0.0.1" || database.pathname !== "/griipbuddy_test" || database.search ||
      !process.env.TEST_OWNER_PASSWORD) throw new Error("The category measurement check requires the isolated loopback profile.");
  test.setTimeout(45_000);
  const origin = new URL(baseURL).origin;
  const headers = { origin };
  await page.context().route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());

  const key = `browse-metrics-${randomUUID().slice(0, 8)}`;
  const branch = `${key}-branch`;
  const leaf = `${key}-leaf`;
  const productId = `${key}-product`;
  const variantId = `v-${productId}`;
  const brand = `Catalog Fixture ${key.slice(-8)}`;
  const title = "Measurement Fixture Desk Stand";
  const image = { src: "/catalog/phone-stand.webp", alt: "Measurement fixture stand" };
  const staff = await page.context().browser()!.newContext({ baseURL });
  try {
    const session = await staff.request.post("/api/staff/sign-in", { headers,
      data: { email: "owner@example.test", password: process.env.TEST_OWNER_PASSWORD } });
    expect(session.ok()).toBe(true);
    const command = async (action: string, input: object) => {
      const response = await staff.request.post("/api/staff/catalog", { headers, data: { action, input } });
      expect(response.status(), action).toBe(200);
    };
    for (const [id, kind, parentId, name] of [
      [key, "DEPARTMENT", null, "Desk Accessories"], [branch, "CATEGORY", key, "Desk Essentials"],
      [leaf, "SUBCATEGORY", branch, "Measurement Fixture Stands"],
    ] as const) {
      await command("category.save", { id, slug: id, kind, parentId, name, shortName: name, image, state: "ACTIVE",
        description: "Catalog measurement fixture category", revision: null, position: 40 });
    }
    await command("product.save", { id: productId, slug: productId, name: title, brand,
      primaryCategoryId: leaf, expectedRevision: null, description: "A desk stand in the category measurement fixture.",
      publication: "DRAFT", options: [], variants: [{ id: variantId, sku: key.toUpperCase(), selections: {} }] });
    await command("product.gallery", { productId, revision: 0, images: [image] });
    await command("offer.configure", { variantId, marketId: "bd", sellerId: "00000000-0000-4000-8000-000000000001",
      amountMinor: 129900, expectedRevision: null, publication: "ACTIVE", eligible: false });
    await command("product.publish", { productId, revision: 1 });
  } finally {
    await staff.close();
  }

  const events: BrowserMeasurement[] = [];
  page.on("response", response => {
    if (!response.ok() || !response.url().endsWith("/api/measurement") || response.request().method() !== "POST") return;
    const observed = response.request().postDataJSON();
    if (observed.version === 1) events.push(observed);
  });
  await page.goto(`/departments/${leaf}?market=bd`);
  await expect(page.getByRole("heading", { name: "Measurement Fixture Stands", exact: true })).toBeVisible();
  expect(await (await page.request.get("/api/measurement")).json()).toMatchObject({ choice: "off" });
  expect(events).toHaveLength(0);
  await page.getByText("Privacy choices", { exact: true }).click();
  await page.getByRole("button", { name: "Allow shopping measurement" }).click();
  await expect(page.getByText("Your choice was saved.", { exact: true })).toBeVisible();
  const impressions = () => events.filter(event => event.action === "CATEGORY_IMPRESSION" && event.categoryId === leaf);
  await expect.poll(() => impressions().length).toBe(1);
  expect(impressions()[0]).toMatchObject({ marketId: "bd", placement: "category-listing", resultCount: 1 });

  const openFilters = page.getByRole("button", { name: "Filters", exact: true });
  const narrow = await openFilters.isVisible();
  if (narrow) await openFilters.click();
  const filters = page.getByRole(narrow ? "dialog" : "complementary", { name: "Filters", exact: true });
  await filters.getByRole("group", { name: "Brand", exact: true }).getByRole("checkbox", { name: new RegExp(brand) }).check();
  await filters.getByRole("button", { name: "Apply filters" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("brand")).toBe(brand.toLowerCase());
  const committed = () => events.find(event => event.action === "CATEGORY_FILTER" && event.categoryId === leaf);
  await expect.poll(() => committed()).toMatchObject({
    marketId: "bd", categoryId: leaf, resultCount: 1, categoryFilters: { fields: ["brand"] },
  });
  expect(JSON.stringify(committed()?.categoryFilters)).not.toContain(brand);
  expect(impressions()).toHaveLength(1);

  const product = page.getByRole("link", { name: new RegExp(title) });
  await product.scrollIntoViewIfNeeded();
  await expect(product.getByText("Unavailable in this market", { exact: true })).toBeVisible();
  await expect(product.locator(".product-card__price")).toHaveCount(0);
  await expect.poll(() => events.find(event => event.action === "PRODUCT_IMPRESSION" && event.categoryId === leaf &&
    event.productId === productId)?.variantId).toBe(variantId);
  await product.click();
  await expect(page).toHaveURL(new RegExp(`/products/${productId}`));
  const clicks = () => events.filter(event => event.action === "PRODUCT_CLICK" && event.categoryId === leaf &&
    event.productId === productId);
  await expect.poll(clicks).toMatchObject([{ placement: "category-grid", variantId, marketId: "bd" }]);
  expect(clicks()[0].currency).toBeUndefined();
  expect(clicks()[0].displayedPriceMinor).toBeUndefined();
});
