import { randomUUID } from "node:crypto";
import { expect, test, type Locator } from "@playwright/test";
import { formatMoney, markets } from "../src/config/markets";
import { saveConnectedOffer } from "../src/lib/commerce/market-offers";
import { getDb } from "../src/lib/db/client";
import { requireLocalDatabase } from "../src/lib/db/local";
import { storeShop } from "../src/lib/marketplace/constants";
import type { BrowserMeasurement } from "../src/lib/measurement/schema";
import { saveDeviceModel } from "../src/lib/staff/device-fitment";

const image = { src: "/catalog/phone-stand.webp", alt: "Fixture category photograph" };
const blue = { src: "/catalog/headphones-taupe.webp", alt: "Blue search fixture case" };
const black = { src: "/catalog/headphones-black.webp", alt: "Black search fixture case" };

test("exact SKU, model aliases, grouped facets and market-aware search use the persisted catalog", async ({ page, baseURL }, info) => {
  test.skip(process.env.GRIIP_CATALOG_STAGE11_BROWSER !== "1", "Use the disposable Stage 11 fixture profile.");
  requireLocalDatabase("griipbuddy_test");
  if (!baseURL || new URL(baseURL).hostname !== "127.0.0.1" || new URL(baseURL).origin !== process.env.BETTER_AUTH_URL) {
    throw new Error("The search browser check requires the isolated loopback app.");
  }
  test.setTimeout(110_000);
  page.setDefaultTimeout(10_000);
  const origin = new URL(baseURL).origin;
  await page.context().route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const suffix = randomUUID().slice(0, 8);
  const prefix = `stage11-${suffix}`;
  const range = `Cabochon${suffix}`;
  const root = `${prefix}-department`;
  const branch = `${prefix}-category`;
  const leaf = `${prefix}-protective`;
  const otherLeaf = `${prefix}-travel`;
  const categoryName = `${range} accessories`;
  const warehouseId = `${prefix}-warehouse`;
  const productId = `${prefix}-case`;
  const productName = `${range} Shield Case`;
  const modelPro = `Aster ${suffix} Pro`;
  const modelMax = `${modelPro} Max`;
  const modelAlias = `MX ${suffix} Pro`;
  const modelIds = [`${prefix}-pro`, `${prefix}-max`];
  const variants = ["pro-plain", "pro-floral", "max-floral"].map(key => `v-${prefix}-${key}`);
  const skus = variants.map(id => id.toUpperCase());
  const exactVariant = variants[2];
  const exactSku = skus[2];
  const media = [blue, blue, black];
  const exactPriceBD = 149900;
  const exactPriceUS = 3699;
  const changedPriceUS = 3899;
  const fillerIds = Array.from({ length: 24 }, (_, index) => `${prefix}-pad-${index}`);
  const productIds = [productId, ...fillerIds];
  const allVariants = [...variants, ...fillerIds.map(id => `v-${id}`)];
  const events: BrowserMeasurement[] = [];
  const db = getDb();
  const searchPath = (q: string, market = "bd", extras = {}) => `/search?${new URLSearchParams({ q, market, ...extras })}`;
  const browserUrl = (href: string | null) => new URL(href!, origin);
  const searchBox = page.getByRole("combobox", { name: /Search products|Search for items or shops/ });
  const suggestions = page.getByRole("listbox", { name: "Search suggestions", exact: true });
  const productSuggestion = () => suggestions.getByRole("option", { name: new RegExp(productName) });
  const resultRegion = page.getByRole("region", { name: "Products", exact: true });
  const product = resultRegion.getByRole("link", { name: new RegExp(productName) });
  const main = page.getByRole("main");
  const owner = (await db.staffAccess.findFirstOrThrow({ where: { active: true, role: "OWNER" } })).userId;
  const staff = { kind: "staff", id: owner } as const;
  const linkFor = async (link: Locator) => browserUrl(await link.getAttribute("href"));
  const suggestionRequest = (url: URL, query: string, market = "bd") =>
    url.pathname === "/api/marketplace/suggest" && url.searchParams.get("q") === query && url.searchParams.get("market") === market;
  page.on("response", response => {
    if (response.ok() && response.url().endsWith("/api/measurement") && response.request().method() === "POST") {
      const event = response.request().postDataJSON();
      if (event.version === 1) events.push(event);
    }
  });

  try {
    const offers = await db.$transaction(async tx => {
      await tx.marketplaceShop.upsert({ where: { id: storeShop.id }, update: {}, create: {
        ...storeShop, published: true, announcement: "", about: "",
      } });
      await tx.dispatchLocation.create({ data: { id: warehouseId, name: "Shared search fixture warehouse", marketId: "bd",
        marketServices: { create: [{ marketId: "bd" }, { marketId: "us" }] } } });
      for (const [id, parentId, kind, name] of [[root, null, "DEPARTMENT", categoryName], [branch, root, "CATEGORY", "Fixture case department"],
        [leaf, branch, "SUBCATEGORY", "Protective search fixtures"], [otherLeaf, branch, "SUBCATEGORY", "Travel search fixtures"]] as const) {
        await tx.department.create({ data: { id, parentId, kind, name, shortName: name, slug: id, position: 20,
          imageSrc: image.src, imageAlt: image.alt, description: "Catalog search fixture category." } });
      }
      await tx.product.create({ data: {
        id: productId, slug: productId, departmentId: leaf, foundation: true, name: productName, brand: "Aster",
        description: "A case with three physical configurations.", keywords: [], specifications: [],
        addedOn: new Date("2026-11-01"), position: 20, publication: "ACTIVE",
        secondaryCategories: { create: { departmentId: otherLeaf } },
        translations: { create: { locale: "en-US", name: productName, description: "Three protective case combinations." } },
      } });
      const options = [
        ["model", "Model", [["pro", modelPro], ["max", modelMax]]],
        ["design", "Design", [["plain", "Plain"], ["floral", "Floral"]]],
        ["colour", "Colour", [["blue", "Blue"], ["black", "Black"]]],
      ] as const;
      for (const [position, [id, label, values]] of options.entries()) {
        await tx.productOption.create({ data: { id, key: id, productId, label, position,
          values: { create: values.map(([valueId, value], index) => ({ id: valueId, label: value, value, position: index })) },
        } });
      }
      await tx.deviceModel.createMany({ data: modelIds.map((id, index) => ({
        id, brand: "Aster", name: (index === 0 ? modelPro : modelMax).slice("Aster ".length),
        lookupKey: (index === 0 ? modelPro : modelMax).toLowerCase(),
      })) });
      await tx.deviceModelAlias.create({ data: { modelId: modelIds[0], label: modelAlias, lookupKey: modelAlias.toLowerCase() } });
      const combinations = [["pro", "plain", "blue"], ["pro", "floral", "blue"], ["max", "floral", "black"]];
      const issued: Record<string, string> = {};
      for (const [position, values] of combinations.entries()) {
        const id = variants[position];
        const selections = options.map(([key], index) => [key, values[index]] as const);
        await tx.variant.create({ data: { id, productId, sku: skus[position], position, managedInventory: true,
          options: Object.fromEntries(selections), optionSignature: JSON.stringify(selections), isDefault: position === 0,
          label: values.join(" "), ...(position === 2 && { mpn: `MPN-${suffix}-MAX` }),
          images: { create: { ...media[position], position: 0, isPrimary: true } } } });
        await tx.variantOptionSelection.createMany({ data: selections.map(([optionId, optionValueId]) => ({ variantId: id, productId, optionId, optionValueId })) });
        await tx.variantCompatibility.create({ data: { variantId: id, modelId: modelIds[position === 2 ? 1 : 0] } });
        await tx.inventoryPool.create({ data: { variantId: id, ownerId: storeShop.id, locationId: warehouseId, onHand: 8 } });
        for (const marketId of ["bd", "us"] as const) {
          if (marketId === "us" && position === 1) continue;
          const offer = await tx.marketOfferIdentity.create({ data: { variantId: id, marketId, sellerId: storeShop.id } });
          await tx.marketOffer.create({ data: { offerId: offer.id, variantId: id, marketId, currency: markets[marketId].currency, eligible: true,
            amountMinor: marketId === "bd" ? position === 2 ? exactPriceBD : 129900 + position * 10000
              : position === 2 ? exactPriceUS : 2499 } });
          issued[`${id}:${marketId}`] = offer.id;
        }
      }
      await tx.product.createMany({ data: fillerIds.map((id, index) => ({
        id, slug: id, departmentId: otherLeaf, name: `${range} travel accessory ${String(index).padStart(2, "0")}`,
        description: "A persisted search pagination fixture.", keywords: [], specifications: [],
        addedOn: new Date("2026-11-01"), position: 100 + index, publication: "ACTIVE",
      })) });
      await tx.variant.createMany({ data: fillerIds.map(id => ({
        id: `v-${id}`, productId: id, sku: id.toUpperCase(), options: {}, label: "Standard", position: 0,
        imageSrc: image.src, imageAlt: image.alt,
      })) });
      await tx.marketOffer.createMany({ data: fillerIds.map((id, index) => ({
        variantId: `v-${id}`, marketId: "bd", currency: "BDT", amountMinor: 49000 + index * 100, eligible: true,
      })) });
      return issued;
    }, { timeout: 20_000 });

    await test.step("match SKU in keyboard suggestions and open the exact variation", async () => {
      await page.goto("/?market=bd");
      await expect(searchBox).toBeVisible();
      await searchBox.fill(categoryName);
      await expect(suggestions.getByRole("option", { name: categoryName, exact: true })).toBeVisible();
      await searchBox.fill(exactSku);
      const direct = productSuggestion();
      await expect(direct).toBeVisible();
      await expect(direct).toContainText(formatMoney(exactPriceBD, markets.bd));
      expect((await linkFor(direct)).searchParams.get("variant")).toBe(exactVariant);
      await searchBox.press("ArrowDown");
      await expect(searchBox).toBeFocused();
      await expect(direct).toHaveAttribute("aria-selected", "true");
      await expect(searchBox).toHaveAttribute("aria-activedescendant", (await direct.getAttribute("id"))!);
      await searchBox.press("Enter");
      await expect(page).toHaveURL(new RegExp(`variant=${exactVariant}`));
      await expect(page.getByRole("radio", { name: modelMax, exact: true })).toBeChecked();
      await expect(page.getByRole("radio", { name: "Floral", exact: true })).toBeChecked();
      await expect(page.getByRole("img", { name: black.alt, exact: true }).first()).toBeVisible();
      const modelPicker = page.getByRole("searchbox", { name: "Search model options" });
      await modelPicker.fill(modelAlias);
      await expect(page.getByRole("radio", { name: modelPro, exact: true })).toBeVisible();
      await expect(page.getByRole("radio", { name: modelMax, exact: true })).toBeChecked();
      await modelPicker.fill("Unknown fixture model");
      await expect(page.getByText("No matching models.", { exact: true })).toBeVisible();
      await expect(page.getByRole("radio", { name: modelPro, exact: true })).toHaveCount(0);
      await expect(page.getByRole("radio", { name: modelMax, exact: true })).toBeChecked();
      expect(events).toHaveLength(0);
    });

    await test.step("restore a model-only match and leave the design open", async () => {
      await page.goto("/?market=bd");
      await page.getByText("Privacy choices", { exact: true }).click();
      await page.getByRole("button", { name: "Allow shopping measurement" }).click();
      await expect(page.getByText("Your choice was saved.", { exact: true })).toBeVisible();
      await searchBox.fill(modelAlias);
      const modelSuggestion = suggestions.getByRole("option", { name: new RegExp(modelPro.slice("Aster ".length)) })
        .and(suggestions.locator('a[href*="model="]'));
      await expect(modelSuggestion).toHaveAttribute("href", new RegExp(`model=${modelIds[0]}`));
      await expect(productSuggestion()).toContainText("From");
      const partial = await linkFor(productSuggestion());
      expect(partial.searchParams.get("variant")).toBeNull();
      expect(partial.searchParams.getAll("option")).toContain("model:pro");
      await searchBox.press("Escape");
      await expect(suggestions).toHaveCount(0);
      await expect(searchBox).toBeFocused();
      await searchBox.press("Enter");
      await expect(product).toHaveCount(1);
      await expect(resultRegion.getByText("1 product", { exact: true })).toBeVisible();
      const href = browserUrl(await product.getAttribute("href"));
      expect(href.searchParams.get("variant")).toBeNull();
      expect(href.searchParams.getAll("option")).toContain("model:pro");
      expect(href.searchParams.getAll("option")).not.toContain("design:floral");
      await expect(searchBox).toHaveValue(modelAlias);
      await expect.poll(() => events.some(event => event.action === "SEARCH" && event.searchStage === "submitted" && event.query === undefined)).toBe(true);
      await expect.poll(() => events.some(event => event.action === "SEARCH" && event.resultCount === 1 && event.marketId === "bd")).toBe(true);
      await product.click();
      await expect(page.getByRole("radio", { name: modelPro, exact: true })).toBeChecked();
      await expect(page.getByRole("radio", { name: "Floral", exact: true })).not.toBeChecked();
      await expect(page.getByRole("button", { name: "Add to cart", exact: true })).toBeDisabled();
    });

    await test.step("keep adjacent models distinct and restore exact and broad links through history", async () => {
      await page.goto(searchPath(`${modelMax} Plain`));
      await expect(resultRegion.getByRole("heading", { name: "No products found" })).toBeVisible();
      await expect(product).toHaveCount(0);

      const modelAndDesign = `${modelAlias} Plain`;
      const query = new URLSearchParams({ q: modelAndDesign, market: "bd", lang: "en-BD", page: "1" });
      const search = await page.request.get(`/api/catalog/search?${query}`);
      expect(search.status()).toBe(200);
      expect(await search.json()).toMatchObject({ total: 1, items: [
        expect.objectContaining({ id: productId, matchedVariantId: variants[0], matchingVariantIds: [variants[0]] }),
      ] });
      await page.goto(searchPath(modelAndDesign));
      await expect(product).toContainText(formatMoney(129900, markets.bd));
      await expect(product.getByRole("img", { name: blue.alt, exact: true })).toBeVisible();
      expect((await linkFor(product)).searchParams.get("variant")).toBe(variants[0]);
      await product.click();
      await expect(main.getByRole("radio", { name: modelPro, exact: true })).toBeChecked();
      await expect(main.getByRole("radio", { name: "Plain", exact: true })).toBeChecked();
      await page.reload();
      await expect(main.getByRole("radio", { name: modelPro, exact: true })).toBeChecked();
      await page.goBack();
      await expect(searchBox).toHaveValue(modelAndDesign);
      await page.goForward();
      await expect(main.getByRole("radio", { name: "Plain", exact: true })).toBeChecked();

      await page.goto(searchPath(productName));
      await expect(product).toHaveCount(1);
      const general = await linkFor(product);
      expect(general.searchParams.get("variant")).toBeNull();
      expect(general.searchParams.getAll("option")).toEqual([]);
      await product.click();
      await expect(main.getByRole("radio", { checked: true })).toHaveCount(0);
      await expect(main.getByRole("button", { name: "Add to cart", exact: true })).toBeDisabled();
    });

    await test.step("use same-variant filters and restore grouped results through history", async () => {
      const scoped = new URLSearchParams({ q: range, sort: "name", market: "bd", lang: "en-BD" });
      const firstPage = await page.request.get(`/api/catalog/search?${scoped}`);
      expect(firstPage.status()).toBe(200);
      const first = await firstPage.json() as { total: number; items: { id: string }[]; nextCursor: string | null };
      expect(first.total).toBe(25);
      expect(first.items).toHaveLength(24);
      expect(first.nextCursor).toEqual(expect.any(String));
      const [cursorPage, numberedPage] = await Promise.all([
        page.request.get(`/api/catalog/search?${scoped}&cursor=${encodeURIComponent(first.nextCursor!)}`),
        page.request.get(`/api/catalog/search?${scoped}&page=2`),
      ]);
      expect(cursorPage.status()).toBe(200);
      expect(numberedPage.status()).toBe(200);
      const second = await cursorPage.json() as { total: number; items: { id: string }[]; nextCursor: string | null };
      expect(second.total).toBe(first.total);
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect(new Set([...first.items, ...second.items].map(({ id }) => id)).size).toBe(first.total);
      expect(await numberedPage.json()).toMatchObject({ total: 25, items: second.items, browse: { page: 2, pageCount: 2 } });

      await page.goto(searchPath(range, "bd", { sort: "name" }));
      await expect(resultRegion.getByText("25 products", { exact: true })).toBeVisible();
      await expect(product).toHaveCount(1);
      await resultRegion.getByRole("link", { name: "Next page" }).click();
      await expect(page).toHaveURL(/page=2/);
      await expect(resultRegion.getByText("Page 2 of 2")).toBeVisible();
      await page.reload();
      await expect(resultRegion.getByText("Page 2 of 2")).toBeVisible();
      await page.goBack();
      await expect(resultRegion.getByText("Page 1 of 2")).toBeVisible();
      await expect(searchBox).toHaveValue(range);
      expect(new URL(page.url()).searchParams.get("sort")).toBe("name");
      await page.goForward();
      await expect(resultRegion.getByText("Page 2 of 2")).toBeVisible();
      const filterToggle = page.getByRole("button", { name: "Filters", exact: true });
      const mobile = await filterToggle.isVisible();
      if (mobile) await filterToggle.click();
      const filters = page.getByRole(mobile ? "dialog" : "complementary", { name: "Filters", exact: true });
      await filters.getByRole("checkbox", { name: modelPro.slice("Aster ".length), exact: true }).check();
      await filters.getByRole("checkbox", { name: "Black", exact: true }).check();
      await filters.getByRole("button", { name: "Apply filters" }).click();
      await expect(resultRegion.getByRole("heading", { name: "No products match these filters" })).toBeVisible();
      expect(new URL(page.url()).searchParams.get("page")).toBeNull();
      await resultRegion.getByRole("link", { name: "Remove Colour: Black" }).click();
      await expect(resultRegion.getByText("1 product", { exact: true })).toBeVisible();
      expect(browserUrl(await product.getAttribute("href")).searchParams.getAll("option")).toContain("model:pro");
    });

    await test.step("respect local offers and refresh after catalog edits and unpublishing", async () => {
      await page.goto(searchPath(modelMax));
      expect(browserUrl(await product.getAttribute("href")).searchParams.get("variant")).toBe(exactVariant);
      await page.goto(searchPath(exactSku));
      await expect(product).toContainText(formatMoney(exactPriceBD, markets.bd));
      await page.getByRole("button", { name: /^Shopping preferences, Bangladesh/ }).click();
      const preferences = page.getByRole("dialog", { name: "Update your settings" });
      await preferences.getByRole("combobox", { name: "Region", exact: true }).selectOption("us");
      const marketResponse = page.waitForResponse(response => {
        const url = new URL(response.url());
        return response.request().isNavigationRequest() && url.pathname === "/search" && url.searchParams.get("market") === "us";
      });
      await preferences.getByRole("button", { name: "Save", exact: true }).click();
      expect((await marketResponse).headers()["x-robots-tag"]).toContain("noindex");
      await expect(searchBox).toHaveValue(exactSku);
      await expect(product).toContainText(formatMoney(exactPriceUS, markets.us));
      await expect(product).not.toContainText(formatMoney(exactPriceBD, markets.bd));
      await expect(product.getByRole("img", { name: black.alt })).toBeVisible();
      const savedLink = await linkFor(product);
      expect(savedLink.searchParams.get("variant")).toBe(exactVariant);
      await product.click();
      await expect(page).toHaveURL(new RegExp(`variant=${exactVariant}`));
      await expect.poll(() => db.measurementEvent.count({ where: { kind: "PRODUCT_CLICK", placement: "search-results",
        marketId: "us", productId, variantId: exactVariant, details: { path: ["offerId"], equals: offers[`${exactVariant}:us`] },
      } })).toBe(1);
      const terms = { variantId: exactVariant, marketId: "us", sellerId: storeShop.id, amountMinor: changedPriceUS };
      const repriced = await saveConnectedOffer(staff, { ...terms, expectedRevision: 0, publication: "ACTIVE", eligible: true });
      await page.goto(searchPath(exactSku, "us"));
      await expect(product).toContainText(formatMoney(changedPriceUS, markets.us));
      const browseOnly = await saveConnectedOffer(staff, { ...terms, expectedRevision: repriced.revision, publication: "ACTIVE", eligible: false });
      await page.reload();
      await expect(product).toContainText("Unavailable in this market");
      await expect(product).not.toContainText(formatMoney(changedPriceUS, markets.us));
      expect((await linkFor(product)).searchParams.get("variant")).toBe(exactVariant);
      await searchBox.click();
      await expect(productSuggestion()).toContainText("Unavailable in this market");
      await expect(productSuggestion()).not.toContainText(formatMoney(changedPriceUS, markets.us));
      await searchBox.press("Escape");

      await saveConnectedOffer(staff, { ...terms, expectedRevision: browseOnly.revision, publication: "DRAFT", eligible: false });
      await page.reload();
      await expect(product).toHaveCount(0);
      await expect(resultRegion.getByRole("heading", { name: "No products found" })).toBeVisible();
      await expect.poll(() => events.some(event => event.action === "SEARCH" && event.resultCount === 0 && event.marketId === "us")).toBe(true);
      await page.goto(savedLink.href);
      await expect(main.getByRole("status").filter({ hasText: "This variant is unavailable in United States." })).toBeVisible();
      await expect(main.getByRole("radio", { checked: true })).toHaveCount(0);
      await expect(main.getByRole("button", { name: "Add to cart", exact: true })).toBeDisabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
    });

    await test.step("ignore a delayed real suggestion after the input changes", async () => {
      await page.goto("/?market=bd");
      let oldResponse: { status: number; variantId: string } | undefined;
      let release = () => {};
      let finish = () => {};
      const hold = new Promise<void>(resolve => { release = resolve; });
      const settled = new Promise<void>(resolve => { finish = resolve; });
      await page.route(url => suggestionRequest(url, exactSku), async route => {
        try {
          const response = await route.fetch({ maxRedirects: 0 });
          const body = await response.json();
          oldResponse = { status: response.status(), variantId: body.products[0]?.variantId };
          await hold;
          await route.fulfill({ response }).catch(() => {});
        } finally {
          finish();
        }
      }, { times: 1 });
      try {
        await searchBox.fill(exactSku);
        await expect.poll(() => oldResponse).toEqual({ status: 200, variantId: exactVariant });
        await searchBox.fill(modelAlias);
        await expect(productSuggestion()).toContainText("From");
      } finally {
        release();
        if (oldResponse) await settled;
      }
      await expect(searchBox).toHaveValue(modelAlias);
      const partial = await linkFor(productSuggestion());
      expect(partial.searchParams.get("variant")).toBeNull();
      expect(partial.searchParams.getAll("option")).toContain("model:pro");
      await productSuggestion().click();
      await expect(main.getByRole("radio", { name: modelPro, exact: true })).toBeChecked();
      await expect(main.getByRole("radio", { name: "Floral", exact: true })).not.toBeChecked();
      const clicks = () => events.filter(event => event.action === "PRODUCT_CLICK" && event.placement === "search-suggestion" &&
        event.marketId === "bd" && event.productId === productId);
      await expect.poll(() => clicks().length).toBe(1);
      expect(clicks()[0].variantId).toBeUndefined();
    });

    await test.step("reject a malformed suggestion response and keep full search usable", async () => {
      await page.goto("/?market=bd");
      await page.route(url => url.pathname === "/api/marketplace/suggest" && url.searchParams.get("q") === exactSku,
        async route => {
          const response = await route.fetch();
          expect(response.ok()).toBe(true);
          const body = await response.json();
          body.products[0].amountMinor = String(body.products[0].amountMinor);
          await route.fulfill({ response, json: body });
        }, { times: 1 });
      await searchBox.fill(exactSku);
      await expect(page.getByText("Suggestions are unavailable. You can still run a search.", { exact: true })).toBeVisible();
      await searchBox.press("Enter");
      await expect(product).toContainText(formatMoney(exactPriceBD, markets.bd));
      expect(browserUrl(await product.getAttribute("href")).searchParams.get("variant")).toBe(exactVariant);
    });

    if (info.project.name === "desktop") await test.step("report a real search outage and retry the same request", async () => {
      const scope = new URLSearchParams({ q: exactSku, market: "bd", lang: "en-BD" });
      const retry = main.getByRole("link", { name: "Try again", exact: true });
      // This branch runs serially against the isolated loopback fixture database.
      await db.$executeRawUnsafe('ALTER TABLE "Variant" RENAME TO "Stage11FixtureUnavailableVariant"');
      try {
        const responses = await Promise.all([
          page.request.get(`/api/catalog/search?${scope}`),
          page.request.get(`/api/marketplace/suggest?${scope}`),
        ]);
        for (const response of responses) {
          expect(response.status()).toBe(503);
          expect(response.headers()["cache-control"]).toContain("no-store");
          expect(await response.json()).toMatchObject({ error: { code: "catalog_unavailable" } });
        }
        await page.goto(searchPath(exactSku, "bd", { design: "Floral", sort: "name" }));
        await expect(main.getByRole("heading", { name: "Search unavailable", exact: true })).toBeVisible();
        expect(Object.fromEntries((await linkFor(retry)).searchParams)).toMatchObject({
          q: exactSku, market: "bd", lang: "en-BD", design: "Floral", sort: "name",
        });
      } finally {
        await db.$executeRawUnsafe('ALTER TABLE "Stage11FixtureUnavailableVariant" RENAME TO "Variant"');
      }
      await retry.click();
      await expect(product).toContainText(formatMoney(exactPriceBD, markets.bd));
      await expect(searchBox).toHaveValue(exactSku);
    });

    await test.step("reflect an approved alias edit on the next live search and suggestion reads", async () => {
      const newAlias = `Renewed ${suffix} Slate`;
      await saveDeviceModel(owner, { id: modelIds[0], brand: "Aster", name: modelPro.slice("Aster ".length), revision: 0, aliases: [newAlias] });
      await page.goto(searchPath(modelAlias));
      await expect(resultRegion.getByRole("heading", { name: "No products found" })).toBeVisible();
      await searchBox.fill(newAlias);
      await expect(productSuggestion()).toBeVisible();
      expect((await linkFor(productSuggestion())).searchParams.getAll("option")).toContain("model:pro");
      await page.getByRole("search", { name: /Store search|Marketplace search/ }).getByRole("button", { name: "Search", exact: true }).click();
      await expect(resultRegion.getByText("1 product", { exact: true })).toBeVisible();
      await expect(searchBox).toHaveValue(newAlias);
      expect((await linkFor(product)).searchParams.getAll("option")).toContain("model:pro");
    });
  } finally {
    await db.$transaction(async tx => {
      await tx.inventoryPool.deleteMany({ where: { locationId: warehouseId } });
      await tx.dispatchLocationMarket.deleteMany({ where: { locationId: warehouseId } });
      await tx.dispatchLocation.deleteMany({ where: { id: warehouseId } });
      await tx.marketOffer.deleteMany({ where: { variantId: { in: allVariants } } });
      await tx.marketOfferIdentity.deleteMany({ where: { variantId: { in: variants } } });
      await tx.auditEvent.deleteMany({ where: { target: { in: [...variants, ...modelIds] } } });
      await tx.variant.deleteMany({ where: { id: { in: allVariants } } });
      await tx.product.deleteMany({ where: { id: { in: productIds } } });
      await tx.deviceModelAlias.deleteMany({ where: { modelId: { in: modelIds } } });
      await tx.deviceModel.deleteMany({ where: { id: { in: modelIds } } });
      for (const id of [otherLeaf, leaf, branch, root]) await tx.department.deleteMany({ where: { id } });
    });
    await db.$disconnect();
  }
});
