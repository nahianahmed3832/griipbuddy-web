import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const workspace = "/staff/catalog/taxonomy";
const image = { src: "/catalog/phone-stand.webp", alt: "Fixture category photograph" };

test("staff category workspace saves placement, redirects, publication and market menus", async ({ page, baseURL }, info) => {
  test.skip(process.env.GRIIP_CATALOG_STAGE7_BROWSER !== "1", "Use the disposable Stage 7 fixture profile.");
  const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  if (!baseURL || new URL(baseURL).hostname !== "127.0.0.1" || process.env.COMMERCE_MODE !== "local" ||
      database.hostname !== "127.0.0.1" || database.pathname !== "/griipbuddy_test" || database.search) {
    throw new Error("Catalog browser checks require the isolated loopback profile.");
  }
  test.setTimeout(90_000);
  page.setDefaultTimeout(12_000);
  const origin = new URL(baseURL).origin;
  await page.context().route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const prefix = `taxonomy-${randomUUID().slice(0, 8)}`;
  const root = `${prefix}-devices`;
  const cases = `${prefix}-cases`;
  const travel = `${prefix}-travel`;
  const original = `${prefix}-original`;
  const originalName = `Everyday Cases ${prefix.slice(-4)}`;
  const leaf = `${prefix}-protective`;
  const newSlug = `${leaf}-new`;
  const product = `${prefix}-product`;
  const collectionId = `${prefix}-collection`;
  const menuKey = `${prefix}-menu`;
  const name = "Canyon Blue Case";
  const collectionName = "Everyday Case Collection";

  async function signIn(target: Page, email: string, password: string | undefined) {
    if (!password) throw new Error("The local fixture account must have a generated password.");
    const response = await target.request.post("/api/staff/sign-in", { headers: { origin }, data: { email, password } });
    expect(response.status()).toBe(200);
  }
  async function command(action: string, input: object, status = 200) {
    const response = await page.request.post("/api/staff/catalog", { headers: { origin }, data: { action, input } });
    expect(response.status(), await response.text()).toBe(status);
    return (await response.json()).data;
  }

  await signIn(page, "owner@example.test", process.env.TEST_OWNER_PASSWORD);
  async function create(id: string, title: string, kind: "DEPARTMENT" | "CATEGORY" | "SUBCATEGORY", parentId: string | null) {
    return command("category.save", { id, slug: id, name: title, shortName: title, description: title, kind,
      parentId, image, state: "ACTIVE", revision: null, position: 10 });
  }
  await create(root, "Portable Gear", "DEPARTMENT", null);
  await create(cases, "Cases", "CATEGORY", root);
  await create(travel, "Travel Gear", "CATEGORY", root);
  await create(original, originalName, "SUBCATEGORY", cases);
  const draft = await command("product.save", {
    id: product, slug: product, name, primaryCategoryId: original, expectedRevision: null, description: "Fixture protective case",
    publication: "DRAFT", options: [], variants: [{ id: `v-${product}`, sku: product.toUpperCase(), selections: {} }],
  });
  const gallery = await command("product.gallery", {
    productId: product, revision: draft.revision, images: [{ ...image, alt: "Fixture protective case", isPrimary: true }],
  });
  await command("offer.save", { variantId: `v-${product}`, marketId: "bd", expectedRevision: null,
    sellerId: "00000000-0000-4000-8000-000000000001", currency: "BDT", amountMinor: 129900, publication: "ACTIVE", eligible: false });
  await command("product.publish", { productId: product, revision: gallery.revision, publication: "ACTIVE" });
  await command("attribute.save", { id: `${prefix}-magnetic`, name: "Magnetic fit", scope: "PRODUCT", dataType: "BOOLEAN" });
  await command("category.attribute", { departmentId: root, attributeId: `${prefix}-magnetic`, expectedRevision: 0,
    template: { required: false, filterable: true, position: 5, inheritable: true } });

  await page.goto(workspace);
  await expect(page.getByRole("heading", { name: "Catalog organization" })).toBeVisible();
  const newCategory = page.getByRole("link", { name: "New category" });
  await newCategory.focus();
  await expect(newCategory).toBeFocused();
  await newCategory.press("Enter");
  await expect(page.getByRole("heading", { name: "Create a category" })).toBeVisible();
  await page.getByRole("combobox", { name: "Level", exact: true }).selectOption("SUBCATEGORY");
  await page.getByRole("combobox", { name: "Parent category", exact: true }).selectOption(cases);
  await page.getByLabel("Stable ID").fill(leaf);
  await page.getByLabel("URL slug", { exact: true }).fill(leaf);
  await page.getByLabel("Name", { exact: true }).fill("Protective Cases");
  await page.getByLabel("Navigation label", { exact: true }).fill("Protective Cases");
  await page.getByLabel("Description", { exact: true }).fill("Protective cases organized by phone model and finish.");
  await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("ACTIVE");
  await page.getByLabel("Category image path").fill(image.src);
  await page.getByLabel("Category image alternative text").fill(image.alt);
  await page.getByRole("button", { name: "Create category" }).click();
  await expect(page).toHaveURL(new RegExp(`category=${leaf}`));
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(page.getByText("Magnetic fit", { exact: true }).first()).toBeVisible();

  const assignments = page.getByRole("form", { name: "Search product assignments" });
  await assignments.getByLabel("Show").selectOption("search");
  await assignments.getByLabel("Search products").fill(product);
  await assignments.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: `Edit assignments for ${name}` }).click();
  const placement = page.getByRole("form", { name: `Edit assignments for ${name}` });
  await placement.getByLabel("Primary category").selectOption(leaf);
  await placement.getByRole("checkbox", { name: new RegExp(originalName) }).check();
  await placement.getByRole("button", { name: "Save assignments" }).click();
  await expect(page.getByText(`Saved category assignments for ${name}.`)).toBeVisible();

  await page.getByRole("button", { name: "Review category impact" }).click();
  await expect(page.getByText(/Archive blocked by 1/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Archive category" })).toBeDisabled();
  await page.getByLabel("New parent category").selectOption(travel);
  await page.getByRole("button", { name: "Move category", exact: true }).click();
  await expect(page.getByText(/Category moved/)).toBeVisible();
  await expect(page.getByText(new RegExp(`Under Travel Gear`))).toBeVisible();

  const seo = page.getByLabel("Canonical URL slug");
  await seo.fill(original);
  await page.getByRole("button", { name: "Save SEO and URL" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /slug.*already in use/i })).toBeVisible();
  await expect(seo).toHaveValue(original);
  const prompt = page.waitForEvent("dialog");
  const leave = page.getByRole("link", { name: "Navigation", exact: true }).click();
  await (await prompt).dismiss();
  await leave;
  await expect(seo).toHaveValue(original);
  await seo.fill(newSlug);
  await page.getByRole("button", { name: "Save SEO and URL" }).click();
  await expect(page.getByText(/SEO and URL.*saved/i)).toBeVisible();
  await expect(async () => {
    const redirect = await page.request.get(`/departments/${leaf}?market=bd`, { maxRedirects: 0 });
    expect(redirect.status()).toBe(308);
    expect(new URL(redirect.headers().location, origin).pathname).toBe(`/departments/${newSlug}`);
  }).toPass({ timeout: 5_000 });

  const productUrl = `/api/catalog/products/${product}?market=bd`;
  const beforeHiding = await page.request.get(productUrl);
  expect(beforeHiding.status()).toBe(200);
  const { variants: beforeVariants } = await beforeHiding.json();
  expect(beforeVariants[0].offer.eligible).toBe(false);

  await page.getByRole("combobox", { name: "Navigation visibility", exact: true }).selectOption("hide");
  await page.getByRole("button", { name: "Save market presentation" }).click();
  await expect(page.getByText("Market presentation saved.")).toBeVisible();
  const afterHiding = await page.request.get(productUrl);
  expect(afterHiding.status()).toBe(200);
  const offers = await afterHiding.json();
  expect(offers.variants[0].offer).toEqual(beforeVariants[0].offer);
  expect(offers.product.primaryCategoryId).toBe(leaf);
  expect(offers.product.secondaryCategoryIds).toEqual([original]);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Navigation visibility", exact: true })).toHaveValue("hide");
  await expect(page.locator("#main-content").getByText(/Under Travel Gear/)).toBeVisible();

  const evidence = process.env.GRIIP_TAXONOMY_EVIDENCE_DIR;
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    if (info.project.name === "desktop") await page.getByRole("searchbox", { name: "Search categories" }).fill(leaf);
    await page.locator(".taxonomy-workspace:visible").evaluate(element => element.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: join(evidence, `category-${info.project.name}.png`), animations: "disabled" });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);

  await page.getByRole("link", { name: "Collections", exact: true }).click();
  await page.getByRole("link", { name: "New collection" }).click();
  await expect(page.getByRole("heading", { name: "New collection", exact: true })).toBeVisible();
  await page.getByLabel("Collection name").fill(collectionName);
  await page.getByLabel("Stable ID").fill(collectionId);
  await page.getByLabel("URL slug", { exact: true }).fill(collectionId);
  await page.getByRole("button", { name: "Save collection" }).click();
  await expect(page).toHaveURL(new RegExp(`collection=${collectionId}`));
  await page.getByLabel("Find products").fill(product);
  await page.getByRole("button", { name: "Search products" }).click();
  await page.getByRole("button", { name: `Add ${name}` }).click();
  await page.getByRole("button", { name: "Save product assignments" }).click();
  await expect(page.getByRole("button", { name: "Publish in market" })).toBeEnabled();
  await page.getByRole("button", { name: "Publish in market" }).click();
  await expect(page.getByRole("button", { name: "Hide in market" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  if (evidence && info.project.name === "desktop") {
    await page.getByRole("region", { name: "Bangladesh publication" }).evaluate(element => element.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: join(evidence, "collection-desktop.png"), animations: "disabled" });
  }

  await page.getByRole("link", { name: "Navigation", exact: true }).click();
  await page.getByLabel("Menu key").fill(menuKey);
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page).toHaveURL(new RegExp(`menuKey=${menuKey}`));
  await page.getByRole("button", { name: "Add link" }).click();
  await page.getByLabel("Link target").selectOption(`collection:${collectionId}`);
  await page.getByRole("button", { name: "Save menu" }).click();
  await expect(page.getByText("Menu saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Menu preview" }).getByRole("link", { name: collectionName })).toBeVisible();
  if (evidence && info.project.name === "desktop") {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(evidence, "navigation-desktop.png"), animations: "disabled" });
  }

  const denied = await page.context().browser()!.newContext({ baseURL });
  await denied.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  try {
    const packer = await denied.newPage();
    await signIn(packer, "packer@example.test", process.env.TEST_PACKER_PASSWORD);
    await packer.goto(workspace);
    await expect(packer.getByRole("heading", { name: "Catalog access is unavailable" })).toBeVisible();
    const invalidWrite = await packer.request.post("/api/staff/catalog", { headers: { origin },
      data: { action: "category.archive", input: { id: leaf, revision: 0 } } });
    expect(invalidWrite.status()).toBe(403);
  } finally {
    await denied.close();
  }

  const delegated = await page.context().browser()!.newContext({ baseURL });
  await delegated.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  try {
    const editor = await delegated.newPage();
    await signIn(editor, "market@example.test", process.env.TEST_MARKET_PASSWORD);
    await editor.goto(`${workspace}?category=${leaf}`);
    await expect(editor.getByRole("heading", { name: "Select a working market" })).toBeVisible();
    const scope = await editor.request.post("/api/staff/catalog/context", { headers: { origin }, data: { marketId: "bd" } });
    expect(scope.status()).toBe(403);
    await editor.getByRole("combobox", { name: "Working market", exact: true }).selectOption("us");
    await expect(editor.getByRole("heading", { name: "Market presentation" })).toBeVisible();
    await expect(editor.getByRole("button", { name: "Save general details" })).toHaveCount(0);
    await editor.getByLabel("Market display order").fill("27");
    await editor.getByRole("button", { name: "Save market presentation" }).click();
    await expect(editor.getByText("Market presentation saved.")).toBeVisible();
    const american = await (await editor.request.get(`/api/catalog/categories/${leaf}?market=us`)).json();
    const bangladesh = await (await editor.request.get(`/api/catalog/categories/${leaf}?market=bd`)).json();
    expect(american.category.position).toBe(27);
    expect(bangladesh.category.position).toBe(100);
  } finally {
    await delegated.close();
  }
});
