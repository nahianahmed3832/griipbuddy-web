import { createHmac, randomUUID } from "node:crypto";
import { expect, test, type BrowserContext } from "@playwright/test";
import { formatMoney, markets } from "../src/config/markets";
import { marketCartStorageKey, decodeCart } from "../src/lib/cart/model";
import { cartSyncRequest } from "../src/lib/cart/sync-contract";
import { checkoutMarketHeader } from "../src/lib/commerce/market-commerce";
import { getDb } from "../src/lib/db/client";
import { requireLocalDatabase } from "../src/lib/db/local";
import { storeShop } from "../src/lib/marketplace/constants";
import type { BrowserMeasurement } from "../src/lib/measurement/schema";

const sharedPhoto = { src: "/catalog/phone-stand.webp", alt: "Shared fixture photograph" };
const photos = [
  { src: "/catalog/headphones-taupe.webp", alt: "Blue fixture case photograph" },
  { src: "/catalog/headphones-black.webp", alt: "Black fixture case photograph" },
];
const detailPhoto = { src: "/catalog/cable.webp", alt: "Blue fixture case detail photograph" };
const marketIds = ["bd", "us"] as const;
const amounts = { bd: [129900, 149900], us: [2499, 2899] };
const combinations = [
  { model: "phone-a", design: "plain", colour: "blue" },
  { model: "phone-b", design: "floral", colour: "black" },
];

function fixtureOption(key: string, label: string, labels: string[]) {
  return {
    id: key, key, label,
    values: labels.map(value => ({ id: value.toLowerCase().replaceAll(" ", "-"), value, label: value })),
  };
}

test("exact variants survive discovery, market changes, native COD and order details in both markets", async ({ page, baseURL }) => {
  test.skip(process.env.GRIIP_CATALOG_STAGE10_BROWSER !== "1", "Use the disposable Stage 10 fixture profile.");
  requireLocalDatabase("griipbuddy_test");
  if (!baseURL || new URL(baseURL).hostname !== "127.0.0.1" ||
      new URL(baseURL).origin !== process.env.BETTER_AUTH_URL || !process.env.TEST_OWNER_PASSWORD) {
    throw new Error("The purchase browser check requires the isolated loopback app and synthetic staff.");
  }

  test.setTimeout(150_000);
  page.setDefaultTimeout(12_000);
  const origin = new URL(baseURL).origin;
  const headers = { origin };
  const db = getDb();
  const step7 = process.env.GRIIP_FRONTEND_STEP7_BROWSER === "1";
  const fixture = `stage10-${randomUUID().slice(0, 8)}`;
  const productId = `${fixture}-case`;
  const productName = "Ridge Purchase Fixture Case";
  const locationId = `${fixture}-warehouse`;
  const thicknessId = `${fixture}-thickness`;
  const warehouseName = "Shared purchase fixture dispatch";
  const method = `${fixture}-ground`;
  const deliveryLabel = "Fixture ground delivery";
  const variantIds = ["a", "b"].map(key => `v-${productId}-${key}`);
  const skus = variantIds.map(id => id.toUpperCase());
  const stockPool = (variantId: string) => ({ variantId_ownerId_locationId: { variantId, ownerId: storeShop.id, locationId } });
  const offerIds = { bd: [] as string[], us: [] as string[] };
  const selections = [["Phone A", "Plain", "Blue"], ["Phone B", "Floral", "Black"]];
  const revisedUsPrice = amounts.us[1] + 200;
  const revisedUsTotal = 8852;
  const orderLines = [2, 1].map((quantity, index) => ({
    variantId: variantIds[index], sku: skus[index], quantity,
    unitPriceMinor: index === 1 ? revisedUsPrice : amounts.us[index], currency: "USD",
    productIdSnapshot: productId, imageSrcSnapshot: photos[index].src,
    optionsSnapshot: expect.arrayContaining(["Model", "Design", "Colour"].map((name, option) => ({
      name, value: selections[index][option],
    }))),
  }));
  const usPolicy = await db.checkoutPolicy.findUniqueOrThrow({ where: { marketId: "us" } });
  const measurements: BrowserMeasurement[] = [];
  page.on("response", response => {
    const request = response.request();
    if (!response.ok() || request.method() !== "POST" || !response.url().endsWith("/api/measurement")) return;
    const event = request.postDataJSON() as BrowserMeasurement;
    if (event.productId === productId) measurements.push(event);
  });

  async function restrictNetwork(context: BrowserContext) {
    context.setDefaultTimeout(12_000);
    await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  }
  await restrictNetwork(page.context());
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: undefined }));
  const staff = await page.context().browser()!.newContext({ baseURL });
  await restrictNetwork(staff);
  const staffLogin = await staff.request.post("/api/staff/sign-in", {
    headers, data: { email: "owner@example.test", password: process.env.TEST_OWNER_PASSWORD },
  });
  expect(staffLogin.status()).toBe(200);

  async function write(action: string, input: object) {
    const response = await staff.request.post("/api/staff/catalog", { headers, data: { action, input } });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()).data;
  }
  async function staffMarket(marketId: "bd" | "us") {
    const response = await staff.request.post("/api/staff/catalog/context", { headers, data: { marketId, permission: "commercial" } });
    expect(response.status()).toBe(200);
  }

  async function storedCart(marketId: "bd" | "us") {
    return decodeCart(await page.evaluate(key => localStorage.getItem(key), marketCartStorageKey(marketId)));
  }

  async function signInShopper(context: BrowserContext, email: string, name: string) {
    const password = randomUUID();
    const signedUp = await context.request.post("/api/shopper-auth/sign-up/email", { headers, data: { name, email, password } });
    expect(signedUp.ok()).toBe(true);
    const signedIn = await context.request.post("/api/shopper-auth/sign-in/email", { headers, data: { email, password } });
    expect(signedIn.ok()).toBe(true);
    return db.shopper.findUniqueOrThrow({ where: { email }, select: { id: true } });
  }

  try {
    await test.step("create two routed variants and offers at the same warehouse", async () => {
      await db.checkoutPolicy.update({ where: { marketId: "us" }, data: {
        enabled: true, codEnabled: true, taxTreatment: "MERCHANDISE_RATE", taxBasisPoints: 500, taxLabel: "Fixture tax",
      } });
      await db.deliveryZone.create({ data: {
        marketId: "us", district: "wa", districtLabel: "Washington", method, label: deliveryLabel, chargeMinor: 350,
      } });
      await db.marketplaceShop.upsert({ where: { id: storeShop.id }, update: {}, create: {
        ...storeShop, published: true, announcement: "", about: "",
      } });
      await db.dispatchLocation.create({ data: { id: locationId, name: warehouseName, marketId: "bd" } });

      for (const [id, parentId, kind, name] of [[fixture, null, "DEPARTMENT", "Purchase fixture"],
        [`${fixture}-cases`, fixture, "CATEGORY", "Fixture cases"],
        [`${fixture}-models`, `${fixture}-cases`, "SUBCATEGORY", "Fixture fitted cases"]] as const) {
        await write("category.save", { id, parentId, kind, name, shortName: name, slug: id, revision: null,
          position: 40, description: "Shared fixture category for two markets.", state: "ACTIVE", image: sharedPhoto });
      }
      await write("attribute.save", { id: thicknessId, name: "Thickness (mm)", scope: "VARIANT", dataType: "NUMBER" });
      await write("category.attribute", { departmentId: `${fixture}-models`, attributeId: thicknessId, expectedRevision: 0,
        template: { position: 0, required: true, filterable: false } });
      await write("product.save", {
        id: productId, slug: productId, name: productName, brand: "Ridge Fixture", primaryCategoryId: `${fixture}-models`,
        expectedRevision: null, description: "Two physical case combinations for isolated purchasing tests.",
        publication: "DRAFT", options: [fixtureOption("model", "Model", ["Phone A", "Phone B"]),
          fixtureOption("design", "Design", ["Plain", "Floral"]), fixtureOption("colour", "Colour", ["Blue", "Black"])],
        variants: combinations.map((selections, index) => ({ id: variantIds[index], sku: skus[index], selections,
          attributeValues: { [thicknessId]: index === 0 ? 1.5 : 2.7 } })),
        defaultVariantId: variantIds[0],
      });
      let revision = (await write("product.gallery", { productId, revision: 0, images: [sharedPhoto] })).revision;
      for (const [marketId, district, deliveryMethod] of [["bd", "dhaka", "standard"], ["us", "wa", method]] as const) {
        await staffMarket(marketId);
        await write("inventory.route", { productId, locationId, marketId, active: true, priority: 0,
          districts: [district], methods: [deliveryMethod], expected: null });
      }
      await staffMarket("bd");
      for (const [index, variantId] of variantIds.entries()) {
        revision = (await write("product.gallery", { productId, variantId, revision,
          images: index === 0 ? [photos[index], detailPhoto] : [photos[index]] })).revision;
        const scope = { productId, marketId: "bd" };
        const pool = await write("inventory.initialize", { ...scope, variantId, locationId });
        await write("inventory.movement", { ...scope, poolId: pool.id, expectedUpdatedAt: pool.updatedAt,
          kind: "RECEIPT", quantity: index === 0 ? 2 : 1,
          idempotencyKey: variantId, reason: "Synthetic fixture receipt", reference: fixture });
      }
      for (const marketId of marketIds) {
        await staffMarket(marketId);
        for (const [index, variantId] of variantIds.entries()) {
          const offer = await write("offer.configure", { variantId, marketId, sellerId: storeShop.id,
            currency: markets[marketId].currency, expectedRevision: null, amountMinor: amounts[marketId][index],
            publication: "ACTIVE", eligible: true,
          });
          offerIds[marketId].push(offer.id);
        }
      }
      await write("product.publish", { productId, revision });
    });

    await test.step("merge the guest cart and restore a signed-in cart mutation after a lost response", async () => {
      const member = await page.context().browser()!.newContext({ baseURL, viewport: page.viewportSize() });
      const email = `${fixture}@example.test`;
      const line = { variantId: variantIds[0], offerId: offerIds.bd[0], quantity: 1 };
      try {
        await restrictNetwork(member);
        const buyer = await member.newPage();
        await buyer.goto(`/products/${productId}?market=bd&variant=${line.variantId}`);
        const delivery = buyer.getByRole("form", { name: "Check delivery", exact: true });
        await delivery.getByRole("combobox", { name: "Delivery district", exact: true }).selectOption("dhaka");
        await delivery.getByRole("combobox", { name: "Delivery service", exact: true }).selectOption("COD:standard");
        await delivery.getByRole("button", { name: "Check delivery", exact: true }).click();
        await buyer.getByRole("main").getByRole("button", { name: "Add to cart", exact: true }).click();
        await buyer.getByRole("link", { name: "View cart", exact: true }).click();
        const cartLine = buyer.getByRole("listitem").filter({ hasText: `SKU ${skus[0]}` });
        await expect(cartLine.getByLabel("Current quantity")).toHaveText("1");

        const { id: shopperId } = await signInShopper(member, email, "Cart purchase fixture");
        const readSavedCart = () => db.shopperCart.findUniqueOrThrow({ where: { shopperId } });
        await buyer.reload();
        await expect(buyer.getByText("Your cart is synced to your account.")).toBeVisible();
        const merged = await readSavedCart();
        expect(merged.items).toEqual([line]);

        const sent: { operationId: string; command: unknown }[] = [];
        await buyer.route("**/api/cart/resolve", async route => {
          const parsed = cartSyncRequest.safeParse(route.request().postDataJSON());
          if (!parsed.success || parsed.data.mode !== "change" || parsed.data.command.type !== "set") return route.continue();
          sent.push({ operationId: parsed.data.operationId, command: parsed.data.command });
          if (sent.length > 1) return route.continue();
          const response = await route.fetch({ maxRedirects: 0 });
          expect(response.ok()).toBe(true);
          await route.abort("failed");
        });
        await cartLine.getByRole("button", { name: "Increase quantity" }).click();
        await expect(buyer.getByRole("button", { name: "Retry cart sync", exact: true })).toBeVisible();
        expect(sent).toEqual([{ operationId: expect.any(String), command: { ...line, type: "set", expectedQuantity: 1, quantity: 2 } }]);
        expect(await readSavedCart()).toMatchObject({ items: [{ ...line, quantity: 2 }], revision: merged.revision + 1 });

        await buyer.reload();
        await expect(buyer.getByText("Your cart is synced to your account.")).toBeVisible();
        await expect(cartLine.getByLabel("Current quantity")).toHaveText("2");
        expect(sent).toEqual([sent[0], sent[0]]);
        expect(await db.shopperCartOperation.count({ where: { shopperId, operationId: sent[0].operationId } })).toBe(1);
        expect(await readSavedCart()).toMatchObject({ items: [{ ...line, quantity: 2 }], revision: merged.revision + 1 });
      } finally {
        await member.close();
        await db.shopper.deleteMany({ where: { email } });
      }
    });

    const main = page.getByRole("main");
    const add = main.getByRole("button", { name: "Add to cart", exact: true });
    const deliveryForm = main.getByRole("form", { name: "Check delivery", exact: true });
    const price = main.locator(".product-detail__price:visible");
    const productStatus = (text: string | RegExp) => main.getByRole("status").filter({ hasText: text });
    const image = (index: number) => main.getByRole("img", { name: photos[index].alt, exact: true }).first();
    const specifications = main.getByRole("region", { name: "Specifications", exact: true });
    const quantityIncrease = main.getByRole("button", { name: "Increase quantity" });
    await test.step("reject variant links from a different product", async () => {
      const legacy = await db.product.findUniqueOrThrow({ where: { id: "p-tote" },
        select: { slug: true, variants: { where: { active: true }, take: 1, select: { id: true } } } });
      await page.goto(`/products/${productId}?market=bd&variant=${legacy.variants[0].id}`);
      await expect(productStatus(/This variant is unavailable in Bangladesh/)).toBeVisible();
      await expect(page.getByRole("radio", { name: "Phone A", exact: true })).not.toBeChecked();
      await expect(add).toBeDisabled();
      await expect(price).toHaveCount(0);
      await page.goto(`/products/${legacy.slug}?market=bd&variant=${variantIds[0]}`);
      await expect(productStatus("This variant is unavailable in Bangladesh.")).toBeVisible();
      await expect(add).toHaveCount(0);
      await page.goto(`/products/${legacy.slug}?market=bd&option=broken&option=color:Plum`);
      await expect(productStatus(/The options in this link don’t match a variant here/)).toBeVisible();
      await expect(price).toHaveCount(0);
    });
    await test.step("recover from a failed exact variant request", async () => {
      const exactRead = (url: URL) => url.pathname.endsWith(`/api/catalog/products/${productId}/variants/${variantIds[0]}`) &&
        !url.searchParams.has("district");
      await page.route(exactRead, route => route.abort("failed"), { times: 1 });
      await page.goto(`/products/${productId}?market=bd&variant=${variantIds[0]}`);
      await expect(productStatus(/Price and availability couldn’t be refreshed/)).toBeVisible();
      await expect(add).toBeDisabled();
      const recovered = page.waitForResponse(response => exactRead(new URL(response.url())) && response.ok());
      await page.getByRole("button", { name: "Retry price check", exact: true }).click();
      expect(await (await recovered).json()).toMatchObject({ variant: { id: variantIds[0], offer: { id: offerIds.bd[0] } } });
      await expect(price).toHaveText(formatMoney(amounts.bd[0], markets.bd));
      await expect(productStatus("Check delivery for this variant.")).toBeVisible();
      await expect(add).toBeDisabled();
    });
    await test.step("use a deep link and keyboard to buy both exact selections", async () => {
      await page.goto(`/products/${productId}?market=bd&variant=${variantIds[0]}`);
      await expect(page.getByRole("radio", { name: "Phone A", exact: true })).toBeChecked();
      await expect(page.getByRole("radio", { name: "Plain", exact: true })).toBeChecked();
      await expect(page.getByRole("radio", { name: "Blue", exact: true })).toBeChecked();
      await expect(image(0)).toBeVisible();
      await expect(page.getByText(`SKU ${skus[0]}`, { exact: true }).filter({ visible: true })).toBeVisible();
      await expect(specifications.getByText("Thickness (mm)", { exact: true })).toBeVisible();
      await expect(specifications.getByText("1.5", { exact: true })).toBeVisible();
      await expect(price).toHaveText(formatMoney(amounts.bd[0], markets.bd));
      await expect(add).toBeDisabled();
      expect(measurements).toHaveLength(0);
      await page.getByText("Privacy choices", { exact: true }).click();
      await page.getByRole("button", { name: "Allow shopping measurement", exact: true }).click();
      await expect(page.getByText("Your choice was saved.", { exact: true })).toBeVisible();
      await expect.poll(() => measurements.filter(event => event.action === "PRODUCT_VIEW" && event.variantId === variantIds[0]))
        .toEqual([expect.objectContaining({ marketId: "bd", offerId: offerIds.bd[0], displayedPriceMinor: amounts.bd[0] })]);
      const gallery = main.getByRole("region", { name: "Product images", exact: true });
      const thumbnail = gallery.getByRole("button", { name: `View image 2: ${detailPhoto.alt}`, exact: true });
      await thumbnail.focus();
      await page.keyboard.press("Enter");
      await expect(gallery.getByRole("img", { name: detailPhoto.alt, exact: true })).toBeVisible();
      await expect(thumbnail).toHaveAttribute("aria-pressed", "true");

      await page.getByRole("button", { name: "Copy product link" }).click();
      const share = new URL(await page.getByRole("textbox", { name: "Copy this link to share your selection" }).inputValue());
      expect(share.searchParams.get("market")).toBe("bd");
      expect(share.searchParams.get("variant")).toBe(variantIds[0]);
      expect(share.searchParams.getAll("option")).toEqual([]);
      if (step7) {
        expect([...share.searchParams.keys()].sort()).toEqual(["lang", "market", "variant"]);
        const browser = page.context().browser()!;
        const recipient = await browser.newContext({ baseURL, viewport: page.viewportSize() });
        try {
          await restrictNetwork(recipient);
          const sharedProduct = await recipient.newPage();
          await sharedProduct.goto(share.href);
          await expect(sharedProduct.getByRole("radio", { name: "Phone A", exact: true })).toBeChecked();
          await expect(sharedProduct.getByRole("radio", { name: "Blue", exact: true })).toBeChecked();
          await expect(sharedProduct.getByRole("img", { name: photos[0].alt, exact: true }).first()).toBeVisible();
        } finally {
          await recipient.close();
        }
      }

      await deliveryForm.getByRole("combobox", { name: "Delivery district", exact: true }).selectOption("dhaka");
      await deliveryForm.getByRole("combobox", { name: "Delivery service", exact: true }).selectOption("COD:standard");
      await page.getByRole("button", { name: "Check delivery", exact: true }).click();
      await expect(productStatus("Available for your delivery selection.")).toBeVisible();
      await expect(add).toBeEnabled();
      expect(measurements.filter(event => event.action === "PRODUCT_VIEW" && event.variantId === variantIds[0])).toHaveLength(1);
      const deliveryEndpoint = (url: URL) => url.pathname.endsWith(`/api/catalog/products/${productId}/variants/${variantIds[1]}`) &&
        url.searchParams.has("district");
      let delayed: { status: number; amount: number; variantId: string; quantity: number } | undefined;
      let resume = () => {};
      let settle = () => {};
      const pending = new Promise<void>(resolve => { resume = resolve; });
      const delivered = new Promise<void>(resolve => { settle = resolve; });
      await page.route(deliveryEndpoint, async route => {
        try {
          const response = await route.fetch({ maxRedirects: 0 });
          const { variant } = await response.json();
          delayed = { status: response.status(), amount: variant.offer.amountMinor, variantId: variant.id, quantity: variant.quantityLimit };
          await pending;
          await route.fulfill({ response }).catch(() => undefined);
        } finally {
          settle();
        }
      });
      try {
        await page.evaluate(variantId => {
          const url = new URL(window.location.href);
          url.searchParams.set("variant", variantId);
          window.history.pushState(null, "", url);
        }, variantIds[1]);
        await expect(image(1)).toBeVisible();
        await expect(add).toBeDisabled();
        await expect.poll(() => delayed).toEqual({ status: 200, amount: amounts.bd[1], variantId: variantIds[1], quantity: 1 });
        await page.goBack();
        await expect(image(0)).toBeVisible();
        await expect(productStatus("Available for your delivery selection.")).toBeVisible();
        await expect(add).toBeEnabled();
      } finally {
        resume();
        if (delayed) await delivered;
        await page.unroute(deliveryEndpoint);
      }
      await expect(page).toHaveURL(new RegExp(`variant=${variantIds[0]}`));
      await expect(price).toHaveText(formatMoney(amounts.bd[0], markets.bd));
      await expect(specifications.getByText("1.5", { exact: true })).toBeVisible();
      await expect(specifications.getByText("2.7", { exact: true })).toHaveCount(0);
      await expect(page.getByText(`SKU ${skus[0]}`, { exact: true }).filter({ visible: true })).toBeVisible();
      await expect(productStatus("Available for your delivery selection.")).toBeVisible();
      await page.goForward();
      await expect(page).toHaveURL(new RegExp(`variant=${variantIds[1]}`));
      await expect(price).toHaveText(formatMoney(amounts.bd[1], markets.bd));
      await expect(specifications.getByText("2.7", { exact: true })).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`variant=${variantIds[0]}`));
      await expect(productStatus("Available for your delivery selection.")).toBeVisible();
      await quantityIncrease.click();
      await expect(quantityIncrease).toBeDisabled();
      const validation = page.waitForRequest(request => new URL(request.url()).pathname.endsWith("/api/cart/resolve") &&
        request.method() === "POST" && request.postDataJSON()?.action === "validate-add");
      await add.click();
      expect((await validation).postDataJSON()).toEqual({ action: "validate-add", marketId: "bd",
        variantId: variantIds[0], offerId: offerIds.bd[0], quantity: 2 });
      await expect(page.getByRole("link", { name: "View cart", exact: true })).toBeVisible();

      await page.getByRole("radio", { name: "Phone B", exact: true }).focus();
      await page.keyboard.press("Space");
      await expect(page.getByRole("radio", { name: "Phone B", exact: true })).toBeChecked();
      await expect(page.getByRole("radio", { name: "Plain", exact: true })).not.toBeChecked();
      await expect(productStatus(/Choose Design and Colour again/i)).toBeVisible();
      await expect(add).toBeDisabled();
      await expect(price).toHaveCount(0);
      await page.getByRole("button", { name: "Copy product link" }).click();
      const partialShare = new URL(await page.getByRole("textbox", { name: "Copy this link to share your selection" }).inputValue());
      expect(partialShare.searchParams.get("variant")).toBeNull();
      expect(partialShare.searchParams.getAll("option")).toEqual(["model:phone-b"]);
      await page.getByRole("radio", { name: "Floral", exact: true }).focus();
      await page.keyboard.press("Space");
      await page.getByRole("radio", { name: "Black", exact: true }).focus();
      await page.keyboard.press("Space");
      await expect(page).toHaveURL(new RegExp(`variant=${variantIds[1]}`));
      await expect(image(1)).toBeVisible();
      await expect(price).toHaveText(formatMoney(amounts.bd[1], markets.bd));
      await expect(specifications.getByText("2.7", { exact: true })).toBeVisible();
      await expect(specifications.getByText("1.5", { exact: true })).toHaveCount(0);
      await expect(productStatus("Available for your delivery selection.")).toBeVisible();
      await expect(quantityIncrease).toBeDisabled();
      await expect.poll(() => measurements.filter(event => event.action === "VARIANT_SELECTION"))
        .toEqual([expect.objectContaining({ marketId: "bd", variantId: variantIds[1], offerId: offerIds.bd[1] })]);
      await add.click();
      expect(await db.inventoryAllocation.count({ where: { offerId: { in: offerIds.bd } } })).toBe(0);
      await page.getByRole("banner").getByRole("link", { name: "Cart, 3 items", exact: true }).click();
      const drawer = page.getByRole("dialog", { name: "Your cart", exact: true });
      for (const [index, amount] of amounts.bd.entries()) {
        const line = drawer.getByRole("listitem").filter({ hasText: skus[index] });
        await expect(line).toContainText(`${formatMoney(amount, markets.bd)} each`);
        await expect(line.getByLabel("Current quantity")).toHaveText(String(orderLines[index].quantity));
      }
      expect(await drawer.evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(
        await drawer.evaluate(element => element.clientWidth));
      await drawer.getByRole("link", { name: "View full cart" }).click();
    });

    function cartLine(index: number) {
      return page.getByRole("listitem").filter({ hasText: `SKU ${skus[index]}` });
    }

    await test.step("keep separate Bangladesh and United States carts for the same variants", async () => {
      for (const [index, amount] of amounts.bd.entries()) {
        await expect(cartLine(index)).toHaveCount(1);
        await expect(cartLine(index)).toContainText(`${formatMoney(amount, markets.bd)} each`);
      }
      await page.getByRole("button", { name: /^Shopping preferences, Bangladesh/ }).click();
      const settings = page.getByRole("dialog", { name: "Update your settings" });
      await settings.getByLabel("Region").selectOption("us");
      await settings.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("button", { name: /^Shopping preferences, United States/ })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Your cart is empty" })).toBeVisible();
      expect(await storedCart("bd")).toEqual(orderLines.map(({ variantId, quantity }, index) => ({
        variantId, quantity, offerId: offerIds.bd[index],
      })));
      for (const [index, { variantId, quantity }] of orderLines.entries()) {
        await page.goto(`/products/${productId}?market=us&variant=${variantId}`);
        await expect(price).toHaveText(formatMoney(amounts.us[index], markets.us));
        await deliveryForm.getByRole("combobox", { name: "State", exact: true }).selectOption("wa");
        await deliveryForm.getByRole("textbox", { name: "ZIP code", exact: true }).fill("98101");
        await deliveryForm.getByRole("combobox", { name: "Delivery service", exact: true }).selectOption(`COD:${method}`);
        await page.getByRole("button", { name: "Check delivery", exact: true }).click();
        await expect(add).toBeEnabled();
        for (let count = 1; count < quantity; count += 1) await quantityIncrease.click();
        await add.click();
        await page.getByRole("link", { name: "View cart", exact: true }).click();
      }
      for (const [index, amount] of amounts.us.entries()) {
        await expect(cartLine(index)).toHaveCount(1);
        await expect(cartLine(index)).toContainText(`${formatMoney(amount, markets.us)} each`);
        await expect(cartLine(index).getByLabel("Current quantity")).toHaveText(String(orderLines[index].quantity));
      }
      await cartLine(0).getByRole("button", { name: "Decrease quantity" }).click();
      await expect.poll(async () => (await storedCart("us")).find(line => line.variantId === variantIds[0])?.quantity).toBe(1);
      await page.reload();
      await expect(cartLine(0).getByLabel("Current quantity")).toHaveText("1");
      await expect(cartLine(1).getByLabel("Current quantity")).toHaveText("1");
      await cartLine(0).getByRole("button", { name: "Increase quantity" }).click();
      await expect(cartLine(0).getByLabel("Current quantity")).toHaveText("2");
    });

    await test.step("find and add the second US variant from its exact SKU result", async () => {
      await cartLine(1).getByRole("button", { name: /^Remove / }).click();
      await expect(cartLine(1)).toHaveCount(0);
      await page.goto(`/departments/${fixture}-models?market=us`);
      await expect(page.getByRole("heading", { name: "Fixture fitted cases", exact: true })).toBeVisible();
      const search = page.getByRole("combobox", { name: /Search products|Search for items or shops/ });
      await search.fill(skus[1]);
      await search.press("Enter");
      await expect(page).toHaveURL(url => url.pathname === "/search" && url.searchParams.get("q") === skus[1]);
      const product = page.getByRole("region", { name: "Products", exact: true }).getByRole("link", { name: new RegExp(productName) });
      await expect(product).toHaveAttribute("href", new RegExp(`variant=${variantIds[1]}`));
      await product.click();
      await expect(page).toHaveURL(new RegExp(`variant=${variantIds[1]}`));
      await expect(price).toHaveText(formatMoney(amounts.us[1], markets.us));
      await expect(productStatus("Check delivery for this variant.")).toBeVisible();
      await deliveryForm.getByRole("combobox", { name: "State", exact: true }).selectOption("wa");
      await deliveryForm.getByRole("textbox", { name: "ZIP code", exact: true }).fill("98101");
      await deliveryForm.getByRole("combobox", { name: "Delivery service", exact: true }).selectOption(`COD:${method}`);
      await page.getByRole("button", { name: "Check delivery", exact: true }).click();
      await expect(add).toBeEnabled();
      await add.click();
      await page.getByRole("link", { name: "View cart", exact: true }).click();
      await expect(cartLine(0)).toContainText(formatMoney(amounts.us[0], markets.us));
      await expect(cartLine(1)).toContainText(formatMoney(amounts.us[1], markets.us));
    });

    let orderId = "";
    await test.step("require confirmation of a revised COD quote and place exactly one order", async () => {
      await page.getByRole("link", { name: /^(Proceed to checkout|Guest checkout)$/ }).click();
      await page.getByLabel("Full name").fill("Jamie Fixture");
      await page.getByLabel("Phone number").fill("2025550100");
      await page.getByLabel("Street address").fill("100 Fixture Avenue");
      await page.getByRole("combobox", { name: "State", exact: true }).selectOption("wa");
      await page.getByLabel("City").fill("Seattle");
      await page.getByLabel("ZIP code").fill("98101");
      await page.getByRole("radio", { name: new RegExp(deliveryLabel) }).check();
      await expect(page.getByRole("radio", { name: /Full cash on delivery/ })).toBeChecked();
      await page.getByRole("button", { name: "Review order", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Review your order" })).toBeVisible();
      const review = page.getByRole("region", { name: "Review your order", exact: true });
      await expect(review).toContainText(formatMoney(8642, markets.us));
      await page.getByText("View order items", { exact: true }).filter({ visible: true }).click();
      for (const sku of skus) await expect(page.getByRole("listitem").filter({ hasText: sku })).toBeVisible();

      await staffMarket("us");
      const original = await db.marketOffer.findUniqueOrThrow({
        where: { variantId_marketId: { variantId: variantIds[1], marketId: "us" } },
      });
      await write("offer.configure", { variantId: variantIds[1], marketId: "us", sellerId: storeShop.id,
        currency: "USD", expectedRevision: original.revision, amountMinor: revisedUsPrice, publication: "ACTIVE", eligible: true });

      const place = page.getByRole("button", { name: "Place COD order", exact: true });
      const staleSubmission = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/api/checkout") &&
        response.request().method() === "POST" && response.request().postDataJSON()?.action === "submit");
      await place.click();
      const stale = await staleSubmission;
      const previousPayload = stale.request().postDataJSON();
      expect(stale.status()).toBe(409);
      expect(await stale.json()).toMatchObject({ kind: "changed", quote: { totalMinor: revisedUsTotal } });
      expect(await db.order.count({ where: { attemptId: previousPayload.checkout.attemptId } })).toBe(0);
      expect(await db.inventoryAllocation.count({ where: { offerId: { in: offerIds.us } } })).toBe(0);
      await expect(review).toContainText(formatMoney(revisedUsTotal, markets.us));
      await expect(page.getByText(/Your order total changed/)).toBeVisible();
      await expect(page.getByLabel("Full name")).toHaveValue("Jamie Fixture");
      await expect(page.getByLabel("Street address")).toHaveValue("100 Fixture Avenue");
      await expect(page.getByRole("radio", { name: new RegExp(deliveryLabel) })).toBeChecked();
      expect(await storedCart("us")).toEqual(expect.arrayContaining(orderLines.map(({ variantId, quantity }) =>
        expect.objectContaining({ variantId, quantity }))));

      const confirmedSubmission = page.waitForRequest(request => new URL(request.url()).pathname.endsWith("/api/checkout") &&
        request.method() === "POST" && request.postDataJSON()?.action === "submit");
      await place.click();
      const payload = (await confirmedSubmission).postDataJSON();
      expect(payload.checkout.attemptId).toBe(previousPayload.checkout.attemptId);
      expect(payload.checkout.reviewToken).not.toBe(previousPayload.checkout.reviewToken);
      await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
      orderId = new URL(page.url()).pathname.split("/").pop()!;

      const replay = await page.request.post("/api/checkout", { headers: { ...headers, [checkoutMarketHeader]: "us" }, data: payload });
      expect(replay.status()).toBe(200);
      expect(await replay.json()).toMatchObject({ kind: "placed", orderId });
      expect(await db.order.count({ where: { attemptId: payload.checkout.attemptId } })).toBe(1);
      expect(await db.inventoryAllocation.count({ where: { offerId: { in: offerIds.us } } })).toBe(2);
      await expect.poll(() => storedCart("us")).toEqual([]);
      await expect.poll(() => db.measurementOrder.count({ where: { orderId } })).toBe(1);
      await page.reload();
      await expect(page.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
      expect(await db.measurementOrder.count({ where: { orderId } })).toBe(1);
      const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: {
        items: { orderBy: { sku: "asc" } }, payment: true, parcels: { include: { items: true } },
        inventoryReservation: { include: { allocations: { include: { pool: true } } } },
      } });
      expect(order.items).toMatchObject(orderLines.map((line, index) => ({ ...line, offerIdSnapshot: offerIds.us[index] })));
      expect(order).toMatchObject({ marketId: "us", currency: "USD", taxMinor: 405, deliveryMinor: 350, totalMinor: revisedUsTotal,
        payment: { method: "COD", status: "AWAITING_COLLECTION", amountMinor: revisedUsTotal, currency: "USD" },
        parcels: [{ locationId, items: expect.arrayContaining([{ parcelId: expect.any(String), orderItemId: order.items[0].id,
          quantity: 2 }, { parcelId: expect.any(String), orderItemId: order.items[1].id, quantity: 1 }]) }],
        inventoryReservation: { state: "COMMITTED", allocations: expect.arrayContaining(orderLines.map((line, index) => ({
          offerId: offerIds.us[index], quantity: line.quantity, pool: expect.objectContaining({ locationId, variantId: line.variantId }),
        })).map(allocation => expect.objectContaining(allocation))) },
      });
    });

    const renamedProduct = "Renamed after purchase";
    await test.step("reorder the same physical variant using current stock and price", async () => {
      const line = page.getByRole("listitem").filter({ hasText: skus[0] });
      await expect(line).toContainText("Out of stock in United States.");
      await expect(line.getByRole("link", { name: /^Buy again/ })).toHaveCount(0);

      await staffMarket("bd");
      const pool = await db.inventoryPool.findUniqueOrThrow({ where: stockPool(variantIds[0]) });
      await write("inventory.movement", { productId, marketId: "bd", poolId: pool.id, expectedUpdatedAt: pool.updatedAt.toISOString(),
        kind: "RECEIPT", quantity: step7 ? 2 : 1, idempotencyKey: `${variantIds[0]}-reorder`, reason: "Synthetic reorder fixture receipt", reference: fixture });

      const newPrice = amounts.us[0] + 300;
      await staffMarket("us");
      const original = await db.marketOffer.findUniqueOrThrow({ where: { variantId_marketId: { variantId: variantIds[0], marketId: "us" } } });
      await write("offer.configure", { variantId: variantIds[0], marketId: "us", sellerId: storeShop.id,
        currency: "USD", expectedRevision: original.revision, amountMinor: newPrice, publication: "ACTIVE", eligible: true });
      await db.product.update({ where: { id: productId }, data: { name: renamedProduct } });

      await page.reload();
      await expect(line).toContainText(productName);
      await expect(line).toContainText(`2 × ${formatMoney(amounts.us[0], markets.us)}`);
      await expect(line).toContainText(`Current price ${formatMoney(newPrice, markets.us)}`);
      await line.getByRole("link", { name: /^Buy again/ }).click();
      await expect(page).toHaveURL(new RegExp(`variant=${variantIds[0]}`));
      await expect(page.getByRole("radio", { name: "Phone A", exact: true })).toBeChecked();
      await expect(price).toHaveText(formatMoney(newPrice, markets.us));
      await expect(page.getByRole("button", { name: "Add to cart", exact: true })).toBeDisabled();
    });

    await test.step("read immutable purchases in the order invoice and staff packing slip", async () => {
      await page.goto(`/orders/${orderId}?paid=true&success=true`);
      await expect(page.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
      const status = page.getByRole("region", { name: "Payment and status", exact: true });
      await expect(status).toContainText("Awaiting collection");
      await expect(status).toContainText(formatMoney(revisedUsTotal, markets.us));
      for (const [index, sku] of skus.entries()) {
        await expect(page.getByRole("listitem").filter({ hasText: sku })
          .getByRole("img", { name: photos[index].alt, exact: true })).toBeVisible();
      }
      await page.getByRole("link", { name: "View invoice" }).click();
      await expect(page.getByRole("heading", { name: "GriipBuddy order invoice" })).toBeVisible();
      for (const line of orderLines) {
        const item = page.getByRole("listitem").filter({ hasText: line.sku });
        await expect(item).toBeVisible();
        await expect(item).toContainText(`${line.quantity} × ${formatMoney(line.unitPriceMinor, markets.us)}`);
      }
      await expect(page.getByText(renamedProduct, { exact: true })).toHaveCount(0);
      const anonymous = await page.context().browser()!.newContext({ baseURL });
      try {
        await restrictNetwork(anonymous);
        const { attemptId, reference } = await db.order.findUniqueOrThrow({ where: { id: orderId },
          select: { attemptId: true, reference: true } });
        const visitor = await anonymous.newPage();
        for (const path of [`/orders/${orderId}?paid=true&success=true`, `/orders/${orderId}/invoice`]) {
          const privatePage = await visitor.goto(path);
          await expect(visitor.getByRole("heading", { name: "Page not found" })).toBeVisible();
          const response = await privatePage!.text();
          for (const detail of [reference, "100 Fixture Avenue", ...skus]) expect(response).not.toContain(detail);
        }
        const recovered = await anonymous.request.post("/api/checkout", { headers: { ...headers, [checkoutMarketHeader]: "us" },
          data: { action: "recover", attemptId } });
        expect(recovered.status()).toBe(409);
        expect(await recovered.json()).toMatchObject({ kind: "conflict" });
      } finally {
        await anonymous.close();
      }
      const packing = await staff.newPage();
      await packing.goto(`/staff/orders/${orderId}`);
      await expect(packing.getByRole("button", { name: "Print packing slip", exact: true })).toBeVisible();
      const slip = packing.locator("article.packing-slip");
      for (const line of orderLines) {
        await expect(slip).toContainText(`${line.quantity} × ${productName}`);
        await expect(slip).toContainText(line.sku);
      }
      await expect(slip).toContainText(warehouseName);
      const mainAdmin = process.env.GRIIP_CATALOG_TEST_MAIN_ADMIN_ORIGIN;
      if (mainAdmin) {
        if (!/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(mainAdmin) || !process.env.GRIIPBUDDY_TEST_FIXTURE_PASSWORD) {
          throw new Error("Use the loopback main admin and the isolated recovered staff fixture.");
        }
        const adminContext = await page.context().browser()!.newContext({ baseURL: mainAdmin, viewport: page.viewportSize() ?? undefined });
        try {
          await adminContext.route("**/*", route => new URL(route.request().url()).origin === mainAdmin ? route.continue() : route.abort());
          const operator = await adminContext.newPage();
          await operator.goto("/admin/sign-in");
          await operator.getByLabel("Phone Number").fill("01000000001");
          await operator.getByLabel("Password", { exact: true }).fill(process.env.GRIIPBUDDY_TEST_FIXTURE_PASSWORD);
          await operator.getByRole("button", { name: "Login", exact: true }).click();
          await expect(operator).toHaveURL(/\/admin\/dashboard\/overview$/);
          await operator.goto(`/admin/dashboard/order-details/native-${orderId}?region=INTERNATIONAL`);
          await expect(operator.getByRole("heading", { name: "Purchased items", exact: true })).toBeVisible();
          await expect(operator.getByRole("button", { name: "Print packing slip", exact: true })).toBeVisible();
          await operator.emulateMedia({ media: "print" });
          const adminSlip = operator.locator('[aria-label="Packing slip"]');
          await expect(adminSlip).toContainText(warehouseName);
          for (const sku of skus) await expect(adminSlip).toContainText(sku);
          await expect(adminSlip).toContainText(productName);
          await expect(adminSlip).not.toContainText("Renamed after purchase");
          await operator.emulateMedia({ media: "screen" });
          await operator.getByRole("button", { name: "Start packing", exact: true }).click();
          await expect(operator.getByRole("button", { name: "Mark ready to ship", exact: true })).toBeVisible();
          const wrongMarket = await adminContext.request.post("/admin/api/connected-catalog", {
            headers: { Origin: mainAdmin }, data: { region: "BD", request: { read: "order", id: orderId } },
          });
          expect(wrongMarket.status()).toBe(404);
          await packing.reload();
        } finally {
          await adminContext.close();
        }
      } else {
        await packing.getByRole("button", { name: "Mark packing", exact: true }).click();
      }
      await expect(packing.getByRole("button", { name: "Mark ready to ship", exact: true })).toBeVisible();
      await expect.poll(async () => (await db.order.findUniqueOrThrow({ where: { id: orderId } })).fulfillmentStatus).toBe("PACKING");
    });

    if (step7) {
      const browser = page.context().browser()!;
      const owner = await browser.newContext({ baseURL, viewport: page.viewportSize(), storageState: await page.context().storageState() });
      const otherShopper = await browser.newContext({ baseURL, viewport: page.viewportSize() });
      try {
        await Promise.all([restrictNetwork(owner), restrictNetwork(otherShopper)]);
        const buyer = await owner.newPage();
        await test.step("keep historic USD snapshots across markets and add only the available exact purchase", async () => {
          await buyer.goto(`/orders/${orderId}?market=bd`);
          const purchased = buyer.locator("main section").filter({
            has: buyer.getByRole("heading", { name: "Purchased items", exact: true }),
          });
          await expect(purchased.getByRole("listitem").filter({ hasText: skus[0] }))
            .toContainText(`2 × ${formatMoney(amounts.us[0], markets.us)}`);
          await expect(purchased.getByRole("listitem").filter({ hasText: skus[1] }))
            .toContainText("Model Phone B · Design Floral · Colour Black");
          await expect(buyer.getByRole("region", { name: "Order summary", exact: true }))
            .toContainText(`${formatMoney(revisedUsTotal, markets.us)} USD`);
          await buyer.getByRole("link", { name: "View invoice", exact: true }).click();
          await expect(buyer.getByRole("region", { name: "Invoice totals", exact: true }))
            .toContainText(`${formatMoney(revisedUsTotal, markets.us)} USD`);
          await buyer.goto(`/orders/${orderId}?market=us`);
          const preview = buyer.getByRole("region", { name: "Items to review", exact: true });
          await expect(preview).toContainText(`2 × ${formatMoney(amounts.us[0] + 300, markets.us)} each`);
          await expect(preview).toContainText("Out of stock in United States.");
          const addReviewed = buyer.getByRole("button", { name: "Add available items to cart", exact: true });
          const result = buyer.getByRole("region", { name: "Reorder results", exact: true });
          await staffMarket("us");
          const current = await db.marketOffer.findUniqueOrThrow({
            where: { variantId_marketId: { variantId: variantIds[0], marketId: "us" } },
          });
          const changedPrice = current.amountMinor + 100;
          await write("offer.configure", { variantId: variantIds[0], marketId: "us", sellerId: storeShop.id,
            currency: "USD", expectedRevision: current.revision, amountMinor: changedPrice, publication: "ACTIVE", eligible: true });
          await addReviewed.click();
          await expect(result).toContainText("0 of 2 purchased lines added to your cart.");
          await expect(result).toContainText(`Price changed to ${formatMoney(changedPrice, markets.us)} each.`);
          expect(decodeCart(await buyer.evaluate(key => localStorage.getItem(key), marketCartStorageKey("us")))).toEqual([]);

          await buyer.reload();
          await expect(preview).toContainText(`2 × ${formatMoney(changedPrice, markets.us)} each`);
          await addReviewed.click();
          await expect(result).toContainText("1 of 2 purchased lines added to your cart.");
          await expect(result).toContainText("Added quantity 2.");
          await expect(result).toContainText("Out of stock in United States.");
          for (const sku of skus) await expect(result).toContainText(sku);
          expect(decodeCart(await buyer.evaluate(key => localStorage.getItem(key), marketCartStorageKey("us")))).toEqual([
            { variantId: variantIds[0], offerId: offerIds.us[0], quantity: 2 },
          ]);
        });

        const ownerEmail = `buyer-${fixture}@example.test`;
        const otherEmail = `unrelated-${fixture}@example.test`;
        const { id: buyerId } = await signInShopper(owner, ownerEmail, "Order owner fixture");
        await signInShopper(otherShopper, otherEmail, "Other shopper fixture");
        await test.step("claim the order and return only the original eligible order line", async () => {
          const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
          const firstLine = order.items.find(item => item.variantId === variantIds[0])!;
          const warning = "Fixture buyer returning one item with the original selected options.";
          const command = { action: "open", orderId, kind: "RETURN", note: warning,
            lines: [{ orderItemId: firstLine.id, quantity: 1 }] };
          const endpoint = "/api/marketplace/cases";
          const caseRequest = (data: object) => owner.request.post(endpoint, { headers, data });

          await buyer.reload();
          await buyer.getByRole("button", { name: "Save order to your account", exact: true }).click();
          await expect(buyer.getByRole("heading", { name: "Manage this order", exact: true })).toBeVisible();
          await expect(buyer.getByRole("region", { name: "Manage this order", exact: true })).toContainText("after delivery");
          expect((await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { shopperId: true } })).shopperId).toBe(buyerId);
          const tooEarly = await caseRequest(command);
          expect(tooEarly.status()).toBe(409);
          expect(await tooEarly.json()).toMatchObject({ message: expect.stringMatching(/after delivery/i) });

          const fulfillment = await staff.newPage();
          try {
            await fulfillment.goto(`/staff/orders/${orderId}`);
            await fulfillment.getByRole("button", { name: "Mark ready to ship", exact: true }).click();
            const parcel = fulfillment.getByRole("region", { name: `Parcel 1 · ${warehouseName}`, exact: true });
            await parcel.getByLabel("Carrier", { exact: true }).fill("Manual isolated fixture");
            await parcel.getByLabel("Tracking reference", { exact: true }).fill(fixture.toUpperCase());
            await parcel.getByRole("button", { name: "Dispatch parcel", exact: true }).click();
            await expect.poll(async () => (await db.order.findUniqueOrThrow({ where: { id: orderId } })).fulfillmentStatus).toBe("SHIPPED");
            await fulfillment.reload();
            await parcel.getByRole("combobox", { name: "Parcel status", exact: true }).selectOption("DELIVERED");
            await parcel.getByLabel("Courier evidence reference", { exact: true }).fill("Isolated fixture delivery evidence");
            await parcel.getByRole("button", { name: "Record parcel update", exact: true }).click();
            await expect.poll(async () => (await db.order.findUniqueOrThrow({ where: { id: orderId } })).fulfillmentStatus).toBe("DELIVERED");

            const excess = await caseRequest({ ...command, lines: [{ orderItemId: firstLine.id, quantity: firstLine.quantity + 1 }] });
            expect(excess.status()).toBe(409);
            expect(await excess.json()).toMatchObject({ message: expect.stringMatching(/quantities/i) });
            expect(await db.orderCase.count({ where: { orderId } })).toBe(0);

            await buyer.reload();
            const status = buyer.getByRole("region", { name: "Payment and status", exact: true });
            await expect(status).toContainText("Delivered");
            await expect(status).toContainText("Awaiting collection");
            const requests = buyer.getByRole("region", { name: "Manage this order", exact: true });
            await requests.getByText("Start a request", { exact: true }).click();
            await requests.getByRole("combobox", { name: "Request type", exact: true }).selectOption("RETURN");
            const quantity = requests.getByRole("spinbutton", { name: new RegExp(`Quantity to return.*${firstLine.sku}`, "i") });
            await expect(quantity).toHaveAttribute("max", String(firstLine.quantity));
            await quantity.fill("1");
            const reason = requests.getByLabel("Reason for your request", { exact: true });
            await reason.fill(warning);

            let committed: { id: string; status: number } | undefined;
            await buyer.route(`**${endpoint}`, async route => {
              const body = route.request().postDataJSON();
              if (committed || body.action !== "open") return route.continue();
              expect(body).toEqual({ ...command, requestId: expect.any(String) });
              const response = await route.fetch({ maxRedirects: 0 });
              const payload = await response.json();
              committed = { id: payload.data?.id, status: response.status() };
              await route.abort("failed");
            });
            await requests.getByRole("button", { name: "Submit request", exact: true }).click();
            await expect.poll(() => committed?.status).toBe(201);
            await expect(reason).toHaveValue(warning);
            await expect(quantity).toHaveValue("1");
            await expect(requests.getByRole("button", { name: "Submit request", exact: true })).toBeDisabled();
            await requests.getByRole("button", { name: "Check order requests", exact: true }).click();
            await requests.getByRole("link", { name: "View request", exact: true }).click();
            await expect(buyer.getByRole("heading", { name: "Return request", exact: true })).toBeVisible();
            const caseId = committed!.id;
            await expect(buyer).toHaveURL(url => url.pathname.endsWith(`/orders/${orderId}/cases/${caseId}`));
            const original = await db.orderCase.findUniqueOrThrow({ where: { id: caseId }, include: { returnLines: true } });
            expect(original).toMatchObject({ orderId, kind: "RETURN", status: "OPEN", revision: 0,
              returnLines: [{ orderItemId: firstLine.id, quantity: 1 }] });
            await expect(buyer.getByRole("main")).toContainText(firstLine.sku);
            await expect(buyer.getByRole("main")).toContainText("Model Phone A · Design Plain · Colour Blue");
            const duplicate = await caseRequest(command);
            expect(duplicate.status()).toBe(409);
            expect(await db.orderCase.count({ where: { orderId, kind: "RETURN" } })).toBe(1);

            const visitor = await otherShopper.newPage();
            for (const path of [`/orders/${orderId}`, `/orders/${orderId}/invoice`, `/orders/${orderId}/cases/${caseId}`]) {
              const denied = await visitor.goto(path);
              await expect(visitor.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();
              const response = await denied!.text();
              for (const detail of [order.reference, warning, "100 Fixture Avenue", ...skus]) expect(response).not.toContain(detail);
              expect(denied!.headers()["cache-control"]).toContain("no-store");
            }
            const forbidden = await otherShopper.request.post(endpoint, { headers,
              data: { action: "withdraw", caseId, revision: original.revision } });
            expect(forbidden.status()).toBe(404);

            await fulfillment.goto(`/staff/orders/${orderId}`);
            await fulfillment.getByRole("link", { name: "Return request · Submitted", exact: true }).click();
            await expect(fulfillment).toHaveURL(url => url.pathname.endsWith(`/staff/cases/${caseId}`));
            await expect(fulfillment.getByRole("main")).toContainText(firstLine.sku);
            const reviewed = await staff.request.post(endpoint, { headers,
              data: { action: "review", caseId, revision: 0, status: "IN_REVIEW", note: "Isolated fixture staff review." } });
            expect(reviewed.status()).toBe(200);
            await buyer.reload();
            await expect(buyer.getByRole("main")).toContainText("In review");
            expect((await db.payment.findUniqueOrThrow({ where: { orderId } })).status).toBe("AWAITING_COLLECTION");
          } finally {
            await fulfillment.close();
          }
        });

        await test.step("persist a clearly labeled product-only favorite and keep archived items removable", async () => {
          await buyer.addInitScript(() => Object.defineProperty(navigator, "share", {
            value: async (data: ShareData) => { sessionStorage.setItem("fixture:shared-product", data.url ?? ""); },
          }));
          const legacyPath = "/products/canvas-carryall-tote?market=bd&variant=v-tote-oat";
          await buyer.goto(`${legacyPath}&customer=fixture-buyer&token=fixture-private-query`);
          await buyer.getByRole("button", { name: "Share product", exact: true }).click();
          const shared = new URL(await buyer.evaluate(() => sessionStorage.getItem("fixture:shared-product") ?? ""));
          expect(shared.origin).toBe(origin);
          expect(shared.pathname).toBe("/products/canvas-carryall-tote");
          expect(shared.searchParams.get("variant")).toBe("v-tote-oat");
          expect([...shared.searchParams.keys()].sort()).toEqual(["lang", "market", "variant"]);
          await buyer.getByRole("button", { name: "Add Canvas Carryall Tote to favorites", exact: true }).click();
          await expect(buyer.getByRole("button", { name: "Remove Canvas Carryall Tote from favorites", exact: true }))
            .toHaveAttribute("aria-pressed", "true");
          await buyer.goto("/favorites?market=bd");
          await buyer.reload();
          await expect(buyer.getByText("Choose options", { exact: true })).toBeVisible();
          const savedLink = buyer.getByRole("main").locator('a[href*="/products/canvas-carryall-tote"]').first();
          const savedUrl = new URL((await savedLink.getAttribute("href"))!, origin);
          expect(savedUrl.searchParams.get("market")).toBe("bd");
          expect(savedUrl.searchParams.has("variant")).toBe(false);
          expect(await db.shopperFavorite.count({ where: { shopperId: buyerId, productId: "p-tote" } })).toBe(1);

          const legacy = await db.product.findUniqueOrThrow({ where: { id: "p-tote" }, select: { publication: true } });
          try {
            await db.product.update({ where: { id: "p-tote" }, data: { publication: "ARCHIVED" } });
            await buyer.reload();
            await expect(buyer.getByText("This product was archived.", { exact: true })).toBeVisible();
            await expect(savedLink).toHaveCount(0);
            await buyer.getByRole("button", { name: "Remove Canvas Carryall Tote from favorites", exact: true }).click();
            await expect.poll(() => db.shopperFavorite.count({ where: { shopperId: buyerId, productId: "p-tote" } })).toBe(0);
          } finally {
            await db.product.update({ where: { id: "p-tote" }, data: legacy });
          }

          const collectionName = "Private fixture collection";
          const created = await owner.request.post("/api/marketplace", { headers,
            data: { action: "create-list", name: collectionName, registry: false } });
          expect(created.status()).toBe(200);
          const { data: { id: listId, public: sharedList } } = await created.json();
          expect(sharedList).toBe(false);
          await buyer.goto(`/lists/${listId}`);
          await expect(buyer.getByRole("heading", { name: collectionName, exact: true })).toBeVisible();
          const unrelated = await otherShopper.newPage();
          await unrelated.goto(`/lists/${listId}`);
          await expect(unrelated.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();
          await expect(unrelated.getByText(collectionName, { exact: true })).toHaveCount(0);
        });
      } finally {
        await Promise.allSettled([owner.close(), otherShopper.close()]);
      }
    }

    await test.step("filter the Bangladesh category and buy the exact BDT offer", async () => {
      await page.goto(`/departments/${fixture}-models?market=bd`);
      await expect(page.getByRole("heading", { name: "Fixture fitted cases", exact: true })).toBeVisible();
      const filterToggle = page.getByRole("button", { name: "Filters", exact: true });
      const mobile = await filterToggle.isVisible();
      if (mobile) await filterToggle.click();
      const filters = page.getByRole(mobile ? "dialog" : "complementary", { name: "Filters", exact: true });
      await filters.getByRole("checkbox", { name: "Phone A", exact: true }).check();
      await filters.getByRole("button", { name: "Apply filters" }).click();
      await expect(page).toHaveURL(url => url.searchParams.has("model"));
      const product = page.getByRole("region", { name: "Products", exact: true }).getByRole("link", { name: new RegExp(renamedProduct) });
      await expect(product).toHaveCount(1);
      await expect(product).toHaveAttribute("href", new RegExp(`[?&]variant=${variantIds[0]}(?:&|$)`));
      await expect(product).toContainText(formatMoney(amounts.bd[0], markets.bd));
      await product.click();
      await expect(page).toHaveURL(new RegExp(`variant=${variantIds[0]}`));
      await expect(page.getByRole("radio", { name: "Phone A", exact: true })).toBeChecked();
      await expect(price).toHaveText(formatMoney(amounts.bd[0], markets.bd));
      await deliveryForm.getByRole("combobox", { name: "Delivery district", exact: true }).selectOption("dhaka");
      await deliveryForm.getByRole("combobox", { name: "Delivery service", exact: true }).selectOption("COD:standard");
      await page.getByRole("button", { name: "Check delivery", exact: true }).click();
      await expect(add).toBeEnabled();
      await add.click();
      await page.getByRole("link", { name: "View cart", exact: true }).click();
      await expect(cartLine(0)).toContainText(formatMoney(amounts.bd[0], markets.bd));
      await expect(cartLine(1)).toHaveCount(0);
      await page.getByRole("link", { name: /^(Proceed to checkout|Guest checkout)$/ }).click();
      await page.getByLabel("Full name").fill("Jamie Fixture");
      await page.getByLabel("Phone number").fill("01700000000");
      await page.getByLabel("Street address").fill("100 Fixture Road");
      await page.getByRole("combobox", { name: "District", exact: true }).selectOption("dhaka");
      await page.getByRole("textbox", { name: "Area or upazila", exact: true }).fill("Dhanmondi");
      await page.getByRole("radio", { name: /Standard delivery/ }).check();
      await expect(page.getByRole("radio", { name: /Full cash on delivery/ })).toBeChecked();
      await page.getByRole("button", { name: "Review order", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Review your order" })).toBeVisible();
      // Save a real order and lose both responses so recovery reads the persisted attempt.
      const submitted: unknown[] = [];
      const committed: string[] = [];
      await page.route("**/api/checkout", async route => {
        const payload = route.request().postDataJSON();
        if (payload?.action !== "submit") return route.continue();
        submitted.push(payload);
        const response = await route.fetch({ maxRedirects: 0 });
        expect(response.ok()).toBeTruthy();
        committed.push((await response.json()).orderId);
        await route.abort("failed");
      });
      const place = page.getByRole("button", { name: "Place COD order", exact: true });
      await expect(place).toBeEnabled();
      await place.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
      const interrupted = page.getByRole("alert").filter({ hasText: "We couldn’t confirm whether the order was placed." });
      await expect(interrupted).toBeVisible();
      expect(submitted).toHaveLength(1);
      const pendingRetry = page.getByRole("button", { name: "Retry same order", exact: true });
      await pendingRetry.click();
      await expect.poll(() => committed.length).toBe(2);
      await expect(interrupted).toBeVisible();
      expect(submitted).toEqual([submitted[0], submitted[0]]);
      const [savedOrderId] = committed;
      expect(committed).toEqual([savedOrderId, savedOrderId]);
      const pendingCart = [{ variantId: variantIds[0], offerId: offerIds.bd[0], quantity: 1 }];
      expect(await storedCart("bd")).toEqual(pendingCart);
      await page.unroute("**/api/checkout");
      await page.reload();
      await expect(page.getByRole("heading", { name: "Check your last order" })).toBeVisible();
      expect(await storedCart("bd")).toEqual(pendingCart);
      const recover = page.getByRole("button", { name: "Check for saved order", exact: true });
      const { attemptId, attempt: { guestKey } } = await db.order.findUniqueOrThrow({ where: { id: savedOrderId },
        select: { attemptId: true, attempt: { select: { guestKey: true } } } });
      const quotaKey = createHmac("sha256", process.env.CHECKOUT_SECRET!).update(`checkout.recover.guest:\0${guestKey}`).digest("hex");
      await db.$executeRaw`INSERT INTO "RequestQuota" ("key", "hits", "resetsAt")
        VALUES (${quotaKey}, 24, CURRENT_TIMESTAMP + INTERVAL '1 minute')`;
      try {
        const limitResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/api/checkout") &&
          response.request().method() === "POST" && response.request().postDataJSON()?.action === "recover");
        await recover.click();
        const limited = await limitResponse;
        expect(limited.status()).toBe(429);
        expect(limited.request().postDataJSON()).toEqual({ action: "recover", attemptId });
        await expect(main.getByRole("alert").filter({ hasText: "Too many checkout requests." })).toBeVisible();
        await expect(recover).toBeEnabled();
        await expect(page.getByRole("heading", { name: "Check your last order" })).toBeVisible();
        expect(await storedCart("bd")).toEqual(pendingCart);
      } finally {
        await db.requestQuota.delete({ where: { key: quotaKey } });
      }
      await recover.click();
      await expect(page.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
      const id = new URL(page.url()).pathname.split("/").at(-1)!;
      expect(id).toBe(savedOrderId);
      const order = await db.order.findUniqueOrThrow({ where: { id }, include: { items: true, payment: true } });
      expect(order).toMatchObject({ marketId: "bd", currency: "BDT", payment: { method: "COD", status: "AWAITING_COLLECTION" },
        items: [{ ...orderLines[0], quantity: 1, currency: "BDT", unitPriceMinor: amounts.bd[0], offerIdSnapshot: offerIds.bd[0] }],
      });
      expect(await db.order.count({ where: { attemptId: order.attemptId } })).toBe(1);
      await expect.poll(() => storedCart("bd")).toEqual([]);
      await expect(page.getByRole("listitem").filter({ hasText: skus[0] })).toContainText("Model Phone A · Design Plain · Colour Blue");
    });
  } finally {
    await staff.close();
    await db.deliveryZone.deleteMany({ where: { marketId: "us", method } });
    await db.checkoutPolicy.update({ where: { marketId: "us" }, data: usPolicy });
    await db.$disconnect();
  }
});
