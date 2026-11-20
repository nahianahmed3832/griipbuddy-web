import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { formatMoney, markets } from "../src/config/markets";
import { getDb } from "../src/lib/db/client";
import { requireLocalDatabase } from "../src/lib/db/local";
import { storeShop } from "../src/lib/marketplace/constants";
import type { BrowserMeasurement } from "../src/lib/measurement/schema";

const image = { src: "/catalog/phone-stand.webp", alt: "Fixture category photograph" };
const blue = { src: "/catalog/headphones-taupe.webp", alt: "Blue search fixture case" };
const black = { src: "/catalog/headphones-black.webp", alt: "Black search fixture case" };

test("exact SKU, model aliases, grouped facets and market-aware search use the persisted catalog", async ({ page, baseURL }) => {
  test.skip(process.env.GRIIP_CATALOG_STAGE11_BROWSER !== "1", "Use the disposable Stage 11 fixture profile.");
  requireLocalDatabase("griipbuddy_test");
  if (!baseURL || new URL(baseURL).hostname !== "127.0.0.1" || new URL(baseURL).origin !== process.env.BETTER_AUTH_URL) {
    throw new Error("The search browser check requires the isolated loopback app.");
  }
  test.setTimeout(85_000);
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
  const searchBox = page.getByRole("searchbox", { name: /Search products|Search for items or shops/ });
  const suggestions = page.getByRole("region", { name: "Search suggestions", exact: true });
  const resultRegion = page.getByRole("region", { name: "Products", exact: true });
  const product = resultRegion.getByRole("link", { name: new RegExp(productName) });
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
        for (const marketId of ["bd", "us"] as const) {
          if (marketId === "us" && position === 1) continue;
          const offer = await tx.marketOfferIdentity.create({ data: { variantId: id, marketId, sellerId: storeShop.id } });
          await tx.marketOffer.create({ data: { offerId: offer.id, variantId: id, marketId, currency: markets[marketId].currency, eligible: false,
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
      await expect(suggestions.getByRole("heading", { name: "Categories", exact: true })).toBeVisible();
      await expect(suggestions.getByRole("link", { name: categoryName, exact: true })).toBeVisible();
      await searchBox.fill(exactSku);
      const direct = suggestions.getByRole("link", { name: new RegExp(productName) });
      await expect(direct).toBeVisible();
      await expect(direct).toContainText(formatMoney(exactPriceBD, markets.bd));
      expect(browserUrl(await direct.getAttribute("href")).searchParams.get("variant")).toBe(exactVariant);
      await searchBox.press("ArrowDown");
      await expect(direct).toBeFocused();
      await direct.press("Enter");
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
      await expect(suggestions.getByRole("heading", { name: "Device models" })).toBeVisible();
      await expect(suggestions.getByRole("link", { name: new RegExp(productName) })).toContainText("Shown option");
      await searchBox.press("Escape");
      await expect(suggestions).toHaveCount(0);
      await searchBox.press("Enter");
      await expect(product).toHaveCount(1);
      await expect(resultRegion.getByText("1 product", { exact: true })).toBeVisible();
      const href = browserUrl(await product.getAttribute("href"));
      expect(href.searchParams.get("variant")).toBeNull();
      expect(href.searchParams.getAll("option")).toContain("model:pro");
      expect(href.searchParams.getAll("option")).not.toContain("design:floral");
      await expect.poll(() => events.some(event => event.action === "SEARCH" && event.searchStage === "submitted" && event.query === undefined)).toBe(true);
      await expect.poll(() => events.some(event => event.action === "SEARCH" && event.resultCount === 1 && event.marketId === "bd")).toBe(true);
      await product.click();
      await expect(page.getByRole("radio", { name: modelPro, exact: true })).toBeChecked();
      await expect(page.getByRole("radio", { name: "Floral", exact: true })).not.toBeChecked();
      await expect(page.getByRole("button", { name: "Add to cart", exact: true })).toBeDisabled();
    });

    await test.step("use same-variant filters and restore grouped results through history", async () => {
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
      const response = await page.goto(searchPath(exactSku, "us"));
      expect(response?.headers()["x-robots-tag"]).toContain("noindex");
      await expect(product).toContainText(formatMoney(exactPriceUS, markets.us));
      await expect(product.getByRole("img", { name: black.alt })).toBeVisible();
      expect(browserUrl(await product.getAttribute("href")).searchParams.get("variant")).toBe(exactVariant);
      await product.click();
      await expect(page).toHaveURL(new RegExp(`variant=${exactVariant}`));
      await expect.poll(() => db.measurementEvent.count({ where: { kind: "PRODUCT_CLICK", placement: "search-results",
        marketId: "us", productId, variantId: exactVariant, details: { path: ["offerId"], equals: offers[`${exactVariant}:us`] },
      } })).toBe(1);
      await db.marketOffer.update({ where: { variantId_marketId: { variantId: exactVariant, marketId: "us" } },
        data: { amountMinor: changedPriceUS, revision: { increment: 1 } } });
      await page.goto(searchPath(exactSku, "us"));
      await expect(product).toContainText(formatMoney(changedPriceUS, markets.us));
      await db.marketOffer.update({ where: { variantId_marketId: { variantId: exactVariant, marketId: "us" } },
        data: { publication: "DRAFT", revision: { increment: 1 } } });
      await page.reload();
      await expect(product).toHaveCount(0);
      await expect(resultRegion.getByRole("heading", { name: "No products found" })).toBeVisible();
      await expect.poll(() => events.some(event => event.action === "SEARCH" && event.resultCount === 0 && event.marketId === "us")).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
    });
  } finally {
    await db.$transaction(async tx => {
      await tx.marketOffer.deleteMany({ where: { variantId: { in: allVariants } } });
      await tx.marketOfferIdentity.deleteMany({ where: { variantId: { in: variants } } });
      await tx.variant.deleteMany({ where: { id: { in: allVariants } } });
      await tx.product.deleteMany({ where: { id: { in: productIds } } });
      await tx.deviceModelAlias.deleteMany({ where: { modelId: { in: modelIds } } });
      await tx.deviceModel.deleteMany({ where: { id: { in: modelIds } } });
      for (const id of [otherLeaf, leaf, branch, root]) await tx.department.deleteMany({ where: { id } });
    });
    await db.$disconnect();
  }
});
