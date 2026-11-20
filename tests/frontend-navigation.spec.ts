import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { formatMoney, markets, type MarketId } from "../src/config/markets";
import { getDb } from "../src/lib/db/client";
import { requireLocalDatabase } from "../src/lib/db/local";

const departmentName = "Fixture desk accessories";
const branchName = "Fixture stands";
const leafName = "Fixture travel stands";
const translatedLeaf = "ভ্রমণের জন্য স্ট্যান্ড";
const translatedMenu = "ভ্রমণ ও দৈনন্দিন ব্যবহারের জন্য ফোন ও ডেস্কের আনুষঙ্গিক সামগ্রী";
const bdLabel = "Shop desk accessories";
const usLabel = "Explore desk accessories";
const searchLabel = "Find an accessory";
const collectionName = "The fixture desk edit";
const collectionDescription = "A curated selection for a compact workspace.";
const collectionImage = { src: "/catalog/phone-stand.webp", alt: "The fixture desk edit photograph" };
const usImage = { src: "/catalog/headphones-black.webp", alt: "US market department photograph" };
const productIds = ["p-stand", "p-cable"];

type MenuItem = { type: "page"; page: "HOME" | "SEARCH" | "SHOP"; label: string; visible?: boolean }
  | { type: "category"; categoryId: string; label: string }
  | { type: "collection"; collectionId: string; label: string };

test("customer navigation follows saved market menus, category relationships and collection publication", async ({ page, baseURL, viewport }) => {
  test.skip(process.env.GRIIP_FRONTEND_STEP2_BROWSER !== "1", "Use the disposable frontend Step 2 fixture profile.");
  requireLocalDatabase("griipbuddy_test");
  if (process.env.GRIIPBUDDY_ENV_FILE !== ".env.test" || !baseURL ||
      new URL(baseURL).hostname !== "127.0.0.1" || !process.env.TEST_OWNER_PASSWORD) {
    throw new Error("The frontend navigation check requires isolated loopback fixtures.");
  }

  test.setTimeout(100_000);
  const origin = new URL(baseURL).origin;
  const headers = { origin };
  await page.context().route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const staff = await page.context().browser()!.newContext({ baseURL });
  const department = `step2-${randomUUID().slice(0, 8)}`;
  const branch = `${department}-stands`;
  const leaf = `${department}-travel`;
  const oldLocalizedSlug = `${leaf}-bn`;
  const newLocalizedSlug = `${leaf}-bangla`;
  const collection = `${department}-desk-edit`;
  const collectionPath = `/collections/${collection}`;
  const categoryPath = (id: string) => `/departments/${id}`;
  const narrow = viewport!.width <= 730;

  async function write(action: string, input: object): Promise<{ revision: number }> {
    const response = await staff.request.post("/api/staff/catalog", { headers, data: { action, input } });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()).data;
  }

  async function selectStaffMarket(marketId: MarketId) {
    const response = await staff.request.post("/api/staff/catalog/context", { headers, data: { marketId } });
    expect(response.status(), await response.text()).toBe(200);
  }

  async function saveMenu(marketId: MarketId, locale: string, items: MenuItem[]) {
    const key = "main";
    const existing = await getDb().marketMenu.findUnique({ where: { marketId_key_locale: { marketId, key, locale } } });
    await write("menu.save", { marketId, key, locale, items, expectedRevision: existing?.revision ?? null });
  }

  const categoryItem = (label: string): MenuItem => ({ type: "category", categoryId: department, label });
  const collectionItem: MenuItem = { type: "collection", collectionId: collection, label: collectionName };
  const searchItem: MenuItem = { type: "page", page: "SEARCH", label: searchLabel };
  const heading = (name: string) => page.getByRole("heading", { name, exact: true });
  const trigger = page.locator('summary[aria-label="Categories"]:visible');
  const drawer = page.getByRole("navigation", { name: "Browse categories", exact: true });
  const bar = page.getByRole("navigation", { name: "Shop navigation", exact: true });
  const close = drawer.getByRole("button", { name: "Close categories", exact: true });
  const link = (label: string) => drawer.getByRole("link", { name: label, exact: true });
  const drill = (label: string) => drawer.getByRole("button", { name: `Browse ${label} subcategories`, exact: true });
  const back = drawer.getByRole("button", { name: "Back", exact: true });
  const results = page.getByRole("region", { name: "Products", exact: true });

  async function openCategories() {
    await trigger.focus();
    await trigger.press("Enter");
    await expect(drawer).toBeVisible();
  }

  async function assertOrderedLabels(labels: string[]) {
    const links = narrow ? drawer.getByRole("list").first().getByRole("link") : bar.getByRole("link");
    await expect(links).toHaveText(labels);
  }

  async function preferences(change: { region?: MarketId; language?: string }) {
    await page.getByRole("button", { name: /^Shopping preferences,/ }).click();
    const dialog = page.getByRole("dialog", { name: "Update your settings" });
    if (change.region) await dialog.getByRole("combobox", { name: "Region", exact: true }).selectOption(change.region);
    if (change.language) await dialog.getByRole("combobox", { name: "Language", exact: true }).selectOption(change.language);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
  }

  try {
    const login = await staff.request.post("/api/staff/sign-in", { headers,
      data: { email: "owner@example.test", password: process.env.TEST_OWNER_PASSWORD } });
    expect(login.status()).toBe(200);
    const defaultMenu = await getDb().marketMenu.findFirst({ where: { marketId: "bd", key: "main", locale: { in: ["", "en", "en-BD"] } } });
    if (!defaultMenu) {
      const absent = await page.request.get("/api/catalog/navigation?market=bd&lang=en-BD");
      expect(absent.status()).toBe(404);
      await page.goto("/?market=bd&lang=en-BD");
      await openCategories();
      await expect(link("Shop all")).toHaveAttribute("href", "/shop?market=bd&lang=en-BD");
      await expect((narrow ? drawer : bar).getByRole("link", { name: "Electronics", exact: true }))
        .toHaveAttribute("href", "/departments/electronics-accessories?market=bd&lang=en-BD");
      await close.press("Enter");
    }
    for (const [id, parentId, kind, name] of [
      [department, null, "DEPARTMENT", departmentName], [branch, department, "CATEGORY", branchName],
      [leaf, branch, "SUBCATEGORY", leafName],
    ] as const) {
      await write("category.save", { id, parentId, kind, name, shortName: name, slug: id, revision: null, position: 20,
        description: "Persisted storefront navigation fixture.", state: "ACTIVE", image: collectionImage });
    }
    const translation = { name: translatedLeaf, shortName: translatedLeaf, description: "ভ্রমণের আনুষঙ্গিক সামগ্রী" };
    const translated = await write("category.translation", { id: leaf, revision: 0, locale: "bn-BD",
      translation: { ...translation, slug: oldLocalizedSlug } });
    const created = await write("collection.save", { id: collection, slug: collection, expectedRevision: null,
      name: collectionName, description: collectionDescription, image: collectionImage, position: 25, selection: "CURATED" });
    const membership = await write("collection.products", { collectionId: collection, expectedRevision: created.revision,
      expectedProductIds: [], productIds });
    await selectStaffMarket("bd");
    const bdPublication = await write("collection.publish", { collectionId: collection, marketId: "bd", published: true,
      expectedRevision: membership.revision });
    await saveMenu("bd", "", [collectionItem, categoryItem(bdLabel), searchItem,
      { type: "page", page: "HOME", label: "Hidden fixture entry", visible: false }]);
    await saveMenu("bd", "bn-BD", [categoryItem(translatedMenu), collectionItem]);
    await selectStaffMarket("us");
    const usPublication = await write("collection.publish", { collectionId: collection, marketId: "us", published: true,
      expectedRevision: bdPublication.revision });
    await write("category.presentation", { id: department, revision: 0, marketId: "us", presentation: { image: usImage } });
    await saveMenu("us", "", [searchItem, categoryItem(usLabel), collectionItem]);

    for (const [market, lang, labels] of [
      ["bd", "en-BD", [collectionName, bdLabel, searchLabel]], ["bd", "bn-BD", [translatedMenu, collectionName]],
      ["us", "en-US", [searchLabel, usLabel, collectionName]],
    ] as const) {
      const menu = await page.request.get(`/api/catalog/navigation?market=${market}&lang=${lang}`);
      expect(menu.status()).toBe(200);
      expect(menu.headers()["cache-control"]).toContain("no-store");
      expect(menu.headers().vary).toContain("Accept-Language");
      const payload = await menu.json();
      expect(payload).toMatchObject({ marketId: market, locale: lang, key: "main",
        items: labels.map(label => expect.objectContaining({ label })) });
      for (const item of payload.items) {
        const href = new URL(item.href, origin);
        expect(href.origin).toBe(origin);
        expect(href.searchParams.get("market")).toBe(market);
        expect(href.searchParams.get("lang")).toBe(lang);
      }
    }
    const missingMenu = await page.request.get(`/api/catalog/navigation?key=${department}&market=us&lang=en-US`);
    expect(missingMenu.status()).toBe(404);
    expect(await missingMenu.json()).toMatchObject({ error: { code: "menu_not_found" } });

    for (const [marketId, locale, amountMinor] of [["bd", "bn-BD", 85000], ["us", "en-US", 1400]] as const) {
      const context = `market=${marketId}&lang=${locale}`;
      const detail = await page.request.get(`/api/catalog/collections/${collection}?${context}`);
      expect(detail.status()).toBe(200);
      const payload = await detail.json();
      expect(payload).toMatchObject({ marketId, locale, collection: { id: collection, slug: collection,
        selection: "CURATED", name: collectionName, description: collectionDescription, image: collectionImage } });
      const listingPath = new URL(payload.collection.productsHref, origin);
      expect(listingPath.origin).toBe(origin);
      expect(listingPath.pathname).toBe("/api/catalog/products");
      expect(Object.fromEntries(listingPath.searchParams)).toEqual({ market: marketId, lang: locale, collection });
      const listing = await page.request.get(listingPath.href);
      expect(listing.status()).toBe(200);
      expect(await listing.json()).toMatchObject({ marketId, locale, items: [
        { id: productIds[0], representative: { offer: { currency: markets[marketId].currency, amountMinor } } },
        { id: productIds[1] },
      ] });
      const collections = await page.request.get(`/api/catalog/collections?${context}`);
      expect(collections.status()).toBe(200);
      expect(await collections.json()).toMatchObject({ marketId, locale, collections: expect.arrayContaining([
        expect.objectContaining({ id: collection }),
      ]) });
    }

    await page.goto("/?market=bd&lang=en-BD");
    await openCategories();
    await assertOrderedLabels([collectionName, bdLabel, searchLabel]);
    await expect(link(searchLabel)).toHaveAttribute("href", "/search?market=bd&lang=en-BD");
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();

    if (narrow) {
      await drill(bdLabel).press("Enter");
      await expect(back).toBeFocused();
      await drill(branchName).press("Enter");
      await expect(back).toBeFocused();
      await expect(link(leafName)).toHaveAttribute("href", `${categoryPath(leaf)}?market=bd&lang=en-BD`);
      await back.press("Enter");
      await expect(drill(branchName)).toBeFocused();
      await back.press("Enter");
      await expect(drill(bdLabel)).toBeFocused();
    } else {
      const submenu = drawer.getByRole("button", { name: bdLabel, exact: true });
      await submenu.press("Enter");
      await expect(submenu).toHaveAttribute("aria-expanded", "true");
      await expect(link(`See all ${bdLabel}`)).toBeFocused();
      await expect(link(branchName)).toHaveAttribute("href", `${categoryPath(branch)}?market=bd&lang=en-BD`);
      await link(leafName).focus();
      await expect(link(leafName)).toBeFocused();
    }
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
    await openCategories();
    await close.press("Enter");
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();

    await openCategories();
    if (narrow) await drill(bdLabel).tap();
    await link(`See all ${bdLabel}`).press("Enter");
    await expect(heading(departmentName)).toBeVisible();
    await expect(page.getByRole("img", { name: collectionImage.alt }).first()).toBeVisible();
    await openCategories();
    if (narrow) await expect(link(bdLabel)).toHaveAttribute("aria-current", "page");
    else await expect(bar.getByRole("link", { name: bdLabel, exact: true })).toHaveAttribute("aria-current", "page");
    await close.press("Enter");

    await page.getByRole("region", { name: "Shop by category" }).getByRole("link", { name: new RegExp(branchName) }).click();
    await expect(heading(branchName)).toBeVisible();
    await page.getByRole("region", { name: "Subcategories" }).getByRole("link", { name: new RegExp(leafName) }).click();
    await expect(heading(leafName)).toBeVisible();
    await expect(heading("No products in this category yet")).toBeVisible();
    const crumbs = page.getByRole("navigation", { name: "Breadcrumb", exact: true });
    await expect(crumbs.getByRole("listitem")).toHaveText(["Home", "Shop all", departmentName, branchName, leafName]);
    await expect(crumbs.getByRole("link", { name: branchName })).toHaveAttribute("href", `${categoryPath(branch)}?market=bd&lang=en-BD`);
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText(leafName);
    await page.reload();
    await expect(heading(leafName)).toBeVisible();
    await page.goBack();
    await expect(heading(branchName)).toBeVisible();
    await page.goForward();
    await expect(heading(leafName)).toBeVisible();

    await preferences({ language: "bn-BD" });
    await expect(heading(translatedLeaf)).toBeVisible();
    await expect(page).toHaveURL(url => url.pathname === categoryPath(oldLocalizedSlug) && url.searchParams.get("market") === "bd");
    await openCategories();
    await assertOrderedLabels([translatedMenu, collectionName]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport!.width);
    await close.press("Enter");

    await write("category.translation", { id: leaf, revision: translated.revision, locale: "bn-BD",
      translation: { ...translation, slug: newLocalizedSlug } });
    const obsoletePath = `${categoryPath(oldLocalizedSlug)}?market=bd&lang=bn-BD`;
    const obsolete = await page.request.get(obsoletePath, { maxRedirects: 0 });
    expect(obsolete.status()).toBe(308);
    expect(new URL(obsolete.headers().location, origin).pathname).toBe(categoryPath(newLocalizedSlug));
    const byAlias = await page.request.get(`/api/catalog/categories/${oldLocalizedSlug}?market=bd&lang=bn-BD`);
    expect(byAlias.status()).toBe(200);
    expect(await byAlias.json()).toMatchObject({ category: { id: leaf, localizedSlug: newLocalizedSlug },
      redirectSlug: newLocalizedSlug, ancestors: [{ id: department }, { id: branch }] });
    await page.goto(obsoletePath);
    await expect(page).toHaveURL(url => url.pathname === categoryPath(newLocalizedSlug));
    await expect(heading(translatedLeaf)).toBeVisible();

    await openCategories();
    await link(collectionName).click();
    await expect(heading(collectionName)).toBeVisible();
    await expect(page.getByText(collectionDescription, { exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: collectionImage.alt })).toBeVisible();
    const productNames = ["Foldaway Phone Stand", "Braided USB-C Cable"];
    await expect(results.getByRole("heading", { level: 3 })).toHaveText(productNames);
    await expect(results.getByRole("link", { name: /Foldaway Phone Stand/ })).toContainText(formatMoney(85000, { ...markets.bd, locale: "bn-BD" }));
    await preferences({ region: "us" });
    await expect(page).toHaveURL(url => url.pathname === collectionPath && url.searchParams.get("market") === "us");
    await expect(results.getByRole("heading", { level: 3 })).toHaveText(productNames);
    await expect(results.getByRole("link", { name: /Foldaway Phone Stand/ })).toContainText(formatMoney(1400, markets.us));
    await openCategories();
    await assertOrderedLabels([searchLabel, usLabel, collectionName]);
    await expect(link(collectionName)).toHaveAttribute("aria-current", "page");
    if (narrow) await drill(usLabel).press("Enter");
    await link(`See all ${usLabel}`).press("Enter");
    await expect(heading(departmentName)).toBeVisible();
    await expect(page.getByRole("img", { name: usImage.alt })).toBeVisible();

    await saveMenu("us", "", [collectionItem, searchItem, categoryItem("Updated US desk accessories")]);
    await page.reload();
    await openCategories();
    await assertOrderedLabels([collectionName, searchLabel, "Updated US desk accessories"]);
    await link(collectionName).click();
    await expect(page).toHaveURL(url => url.pathname === collectionPath && url.searchParams.get("market") === "us");
    await expect(heading(collectionName)).toBeVisible();
    const emptied = await write("collection.products", { collectionId: collection, expectedRevision: usPublication.revision,
      expectedProductIds: productIds, productIds: [] });
    await page.reload();
    await expect(heading("This collection is empty")).toBeVisible();
    await expect(results.getByRole("heading", { level: 3 })).toHaveCount(0);
    await write("collection.publish", { collectionId: collection, marketId: "us", published: false, expectedRevision: emptied.revision });
    await page.reload();
    await expect(heading("Collection unavailable")).toBeVisible();
    await expect(page.getByRole("link", { name: "Browse products", exact: true })).toHaveAttribute("href", "/shop?market=us&lang=en-US");
    const unavailable = await page.request.get(`/api/catalog/collections/${collection}?market=us&lang=en-US`);
    expect(unavailable.status()).toBe(404);
    expect(await unavailable.json()).toMatchObject({ error: { code: "collection_not_found" } });
    const available = await page.request.get("/api/catalog/collections?market=us&lang=en-US");
    expect(available.status()).toBe(200);
    expect((await available.json()).collections).not.toContainEqual(expect.objectContaining({ id: collection }));
    await openCategories();
    await assertOrderedLabels([searchLabel, "Updated US desk accessories"]);
    await close.press("Enter");

    await saveMenu("us", "en-US", []);
    const empty = await page.request.get("/api/catalog/navigation?market=us&lang=en-US");
    expect(empty.status()).toBe(200);
    expect(await empty.json()).toMatchObject({ marketId: "us", locale: "en-US", items: [] });
    await page.goto("/?market=us&lang=en-US");
    await openCategories();
    await expect(drawer.getByRole("link")).toHaveCount(0);
    await expect(drawer.getByText("Use search to find products in this market.")).toBeVisible();
    await page.goto(`${categoryPath(`${leaf}-missing`)}?market=us&lang=en-US`);
    await expect(heading("Category unavailable")).toBeVisible();
    await expect(page.getByRole("link", { name: "Browse products", exact: true })).toHaveAttribute("href", "/shop?market=us&lang=en-US");
  } finally {
    await staff.close();
  }
});
