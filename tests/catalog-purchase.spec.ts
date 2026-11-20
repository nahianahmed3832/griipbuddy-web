import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext } from "@playwright/test";
import { formatMoney, markets } from "../src/config/markets";
import { CART_STORAGE_KEY, decodeCart } from "../src/lib/cart/model";
import { getDb } from "../src/lib/db/client";
import { requireLocalDatabase } from "../src/lib/db/local";
import { storeShop } from "../src/lib/marketplace/constants";

const sharedPhoto = { src: "/catalog/phone-stand.webp", alt: "Shared fixture photograph" };
const photos = [
  { src: "/catalog/headphones-taupe.webp", alt: "Blue fixture case photograph" },
  { src: "/catalog/headphones-black.webp", alt: "Black fixture case photograph" },
];
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
  const fixture = `stage10-${randomUUID().slice(0, 8)}`;
  const productId = `${fixture}-case`;
  const productName = "Ridge Purchase Fixture Case";
  const locationId = `${fixture}-warehouse`;
  const warehouseName = "Shared purchase fixture dispatch";
  const method = `${fixture}-ground`;
  const deliveryLabel = "Fixture ground delivery";
  const variantIds = ["a", "b"].map(key => `v-${productId}-${key}`);
  const skus = variantIds.map(id => id.toUpperCase());
  const stockPool = (variantId: string) => ({ variantId_ownerId_locationId: { variantId, ownerId: storeShop.id, locationId } });
  const offerIds = { bd: [] as string[], us: [] as string[] };
  const selections = [["Phone A", "Plain", "Blue"], ["Phone B", "Floral", "Black"]];
  const orderLines = [2, 1].map((quantity, index) => ({
    variantId: variantIds[index], sku: skus[index], quantity, unitPriceMinor: amounts.us[index], currency: "USD",
    productIdSnapshot: productId, imageSrcSnapshot: photos[index].src,
    optionsSnapshot: expect.arrayContaining(["Model", "Design", "Colour"].map((name, option) => ({
      name, value: selections[index][option],
    }))),
  }));
  const usPolicy = await db.checkoutPolicy.findUniqueOrThrow({ where: { marketId: "us" } });

  async function restrictNetwork(context: BrowserContext) {
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
      await write("product.save", {
        id: productId, slug: productId, name: productName, brand: "Ridge Fixture", primaryCategoryId: `${fixture}-models`,
        expectedRevision: null, description: "Two physical case combinations for isolated purchasing tests.",
        publication: "DRAFT", options: [fixtureOption("model", "Model", ["Phone A", "Phone B"]),
          fixtureOption("design", "Design", ["Plain", "Floral"]), fixtureOption("colour", "Colour", ["Blue", "Black"])],
        variants: combinations.map((selections, index) => ({ id: variantIds[index], sku: skus[index], selections })),
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
        revision = (await write("product.gallery", { productId, variantId, revision, images: [photos[index]] })).revision;
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

    const add = page.getByRole("button", { name: "Add to cart", exact: true });
    const deliveryForm = page.getByRole("form", { name: "Check delivery", exact: true });
    const price = page.locator(".product-detail__price:visible");
    const productStatus = (text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
    const image = (index: number) => page.getByRole("img", { name: photos[index].alt, exact: true }).first();
    await test.step("reject variant links from a different product", async () => {
      const legacy = await db.product.findUniqueOrThrow({ where: { id: "p-tote" },
        select: { slug: true, variants: { where: { active: true }, take: 1, select: { id: true } } } });
      await page.goto(`/products/${productId}?market=bd&variant=${legacy.variants[0].id}`);
      await expect(productStatus(/This variant is unavailable in Bangladesh/)).toBeVisible();
      await expect(page.getByRole("radio", { name: "Phone A", exact: true })).not.toBeChecked();
      await expect(add).toBeDisabled();
      await expect(price).toHaveCount(0);
      await page.goto(`/products/${legacy.slug}?market=bd&variant=${variantIds[0]}`);
      await expect(productStatus("These options are unavailable in Bangladesh.")).toBeVisible();
      await expect(add).toHaveCount(0);
      await page.goto(`/products/${legacy.slug}?market=bd&option=broken&option=color:Plum`);
      await expect(productStatus(/The options in this link don’t match a variant here/)).toBeVisible();
      await expect(price).toHaveCount(0);
    });
    await test.step("use a deep link and keyboard to buy both exact selections", async () => {
      await page.goto(`/products/${productId}?market=bd&variant=${variantIds[0]}`);
      await expect(page.getByRole("radio", { name: "Phone A", exact: true })).toBeChecked();
      await expect(page.getByRole("radio", { name: "Plain", exact: true })).toBeChecked();
      await expect(page.getByRole("radio", { name: "Blue", exact: true })).toBeChecked();
      await expect(image(0)).toBeVisible();
      await expect(page.getByText(`SKU ${skus[0]}`, { exact: true }).filter({ visible: true })).toBeVisible();
      await expect(price).toHaveText(formatMoney(amounts.bd[0], markets.bd));
      await expect(add).toBeDisabled();

      await page.getByRole("button", { name: "Copy product link" }).click();
      const share = new URL(await page.getByRole("textbox", { name: "Copy this link to share your selection" }).inputValue());
      expect(share.searchParams.get("market")).toBe("bd");
      expect(share.searchParams.get("variant")).toBe(variantIds[0]);
      expect(share.searchParams.getAll("option")).toEqual([]);

      await deliveryForm.getByRole("combobox", { name: "Delivery district", exact: true }).selectOption("dhaka");
      await deliveryForm.getByRole("combobox", { name: "Delivery service", exact: true }).selectOption("COD:standard");
      await page.getByRole("button", { name: "Check delivery", exact: true }).click();
      await expect(productStatus("Available for your delivery selection.")).toBeVisible();
      await expect(add).toBeEnabled();
      const deliveryEndpoint = (url: URL) => url.pathname.includes(`/api/catalog/products/${productId}/variants/`) && url.searchParams.has("district");
      let resume!: () => void;
      const pending = new Promise<void>(resolve => { resume = resolve; });
      await page.route(deliveryEndpoint, async route => {
        await pending;
        await route.continue().catch(() => undefined);
      });
      try {
        await page.evaluate(variantId => {
          const url = new URL(window.location.href);
          url.searchParams.set("variant", variantId);
          window.history.pushState(null, "", url);
        }, variantIds[1]);
        await expect(image(1)).toBeVisible();
        await expect(add).toBeDisabled();
        await page.goBack();
        await expect(image(0)).toBeVisible();
        await expect(productStatus("Checking delivery…")).toBeVisible();
        await expect(add).toBeDisabled();
      } finally {
        resume();
        await page.unroute(deliveryEndpoint);
      }
      await expect(productStatus("Available for your delivery selection.")).toBeVisible();
      const increase = page.getByRole("button", { name: "Increase quantity" });
      await increase.click();
      await expect(increase).toBeDisabled();
      await add.click();
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
      await expect(productStatus("Available for your delivery selection.")).toBeVisible();
      await expect(increase).toBeDisabled();
      await add.click();
      await page.getByRole("link", { name: "View cart", exact: true }).click();
    });

    function cartLine(index: number) {
      return page.getByRole("listitem").filter({ hasText: `SKU ${skus[index]}` });
    }

    await test.step("keep two distinct cart lines and reprice their exact variants in the United States", async () => {
      for (const [index, amount] of amounts.bd.entries()) {
        await expect(cartLine(index)).toHaveCount(1);
        await expect(cartLine(index)).toContainText(`${formatMoney(amount, markets.bd)} each`);
      }
      await page.getByRole("button", { name: /^Shopping preferences, Bangladesh/ }).click();
      const settings = page.getByRole("dialog", { name: "Update your settings" });
      await settings.getByLabel("Region").selectOption("us");
      await settings.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("button", { name: /^Shopping preferences, United States/ })).toBeVisible();
      for (const [index, amount] of amounts.us.entries()) {
        await expect(cartLine(index)).toHaveCount(1);
        await expect(cartLine(index)).toContainText(`${formatMoney(amount, markets.us)} each`);
        await expect(cartLine(index).getByLabel("Current quantity")).toHaveText(String(orderLines[index].quantity));
      }
    });

    await test.step("find and add the second US variant from its exact SKU result", async () => {
      await cartLine(1).getByRole("button", { name: /^Remove / }).click();
      await expect(cartLine(1)).toHaveCount(0);
      await page.goto(`/departments/${fixture}-models?market=us`);
      await expect(page.getByRole("heading", { name: "Fixture fitted cases", exact: true })).toBeVisible();
      const search = page.getByRole("searchbox", { name: /Search products|Search for items or shops/ });
      await search.fill(skus[1]);
      await search.press("Enter");
      const product = page.getByRole("region", { name: "Products", exact: true }).getByRole("link", { name: new RegExp(productName) });
      await expect(product).toHaveCount(1);
      await product.click();
      await expect(page).toHaveURL(new RegExp(`variant=${variantIds[1]}`));
      await expect(price).toHaveText(formatMoney(amounts.us[1], markets.us));
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
    await test.step("review and place a native COD order through the browser", async () => {
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
      await page.getByText("View order items", { exact: true }).filter({ visible: true }).click();
      for (const sku of skus) await expect(page.getByRole("listitem").filter({ hasText: sku })).toBeVisible();
      await page.getByRole("button", { name: "Place COD order", exact: true }).click();
      await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
      orderId = new URL(page.url()).pathname.split("/").pop()!;
      const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: {
        items: { orderBy: { sku: "asc" } }, payment: true, parcels: { include: { items: true } },
        inventoryReservation: { include: { allocations: { include: { pool: true } } } },
      } });
      expect(order.items).toMatchObject(orderLines.map((line, index) => ({ ...line, offerIdSnapshot: offerIds.us[index] })));
      expect(order).toMatchObject({ marketId: "us", currency: "USD", taxMinor: 395, deliveryMinor: 350, totalMinor: 8642,
        payment: { method: "COD", status: "AWAITING_COLLECTION", amountMinor: 8642, currency: "USD" },
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
        kind: "RECEIPT", quantity: 1, idempotencyKey: `${variantIds[0]}-reorder`, reason: "Synthetic reorder fixture receipt", reference: fixture });

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
      await page.goto(`/orders/${orderId}`);
      await page.getByRole("link", { name: "View invoice" }).click();
      await expect(page.getByRole("heading", { name: "GriipBuddy order invoice" })).toBeVisible();
      for (const [index, line] of orderLines.entries()) {
        const item = page.getByRole("listitem").filter({ hasText: line.sku });
        await expect(item).toBeVisible();
        await expect(item).toContainText(`${line.quantity} × ${formatMoney(amounts.us[index], markets.us)}`);
      }
      await expect(page.getByText(renamedProduct, { exact: true })).toHaveCount(0);
      const anonymous = await page.context().browser()!.newContext({ baseURL });
      try {
        await restrictNetwork(anonymous);
        const visitor = await anonymous.newPage();
        const invoice = await visitor.goto(`/orders/${orderId}/invoice`);
        await expect(visitor.getByRole("heading", { name: "Page not found" })).toBeVisible();
        const response = await invoice!.text();
        expect(response).not.toContain("100 Fixture Avenue");
        for (const sku of skus) expect(response).not.toContain(sku);
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
      await packing.getByRole("button", { name: "Mark packing", exact: true }).click();
      await expect(packing.getByRole("button", { name: "Mark ready to ship", exact: true })).toBeVisible();
      await expect.poll(async () => (await db.order.findUniqueOrThrow({ where: { id: orderId } })).fulfillmentStatus).toBe("PACKING");
    });

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
      // Save a real order, then lose its browser response so recovery reads the persisted attempt.
      let savedOrderId = "";
      await page.route("**/api/checkout", async route => {
        if (route.request().postDataJSON().action !== "submit") return route.continue();
        const response = await route.fetch();
        expect(response.ok()).toBeTruthy();
        savedOrderId = (await response.json()).orderId;
        await route.abort("failed");
      });
      await page.getByRole("button", { name: "Place COD order", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "We couldn’t confirm whether the order was placed." })).toBeVisible();
      const storedCart = await page.evaluate(key => localStorage.getItem(key), CART_STORAGE_KEY);
      expect(decodeCart(storedCart)).toEqual([{ variantId: variantIds[0], offerId: offerIds.bd[0], quantity: 1 }]);
      await page.unroute("**/api/checkout");
      await page.reload();
      await expect(page.getByRole("heading", { name: "Check your last order" })).toBeVisible();
      await page.getByRole("button", { name: "Check for saved order", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
      const id = new URL(page.url()).pathname.split("/").at(-1)!;
      expect(id).toBe(savedOrderId);
      const order = await db.order.findUniqueOrThrow({ where: { id }, include: { items: true, payment: true } });
      expect(order).toMatchObject({ marketId: "bd", currency: "BDT", payment: { method: "COD", status: "AWAITING_COLLECTION" },
        items: [{ ...orderLines[0], quantity: 1, currency: "BDT", unitPriceMinor: amounts.bd[0], offerIdSnapshot: offerIds.bd[0] }],
      });
      await expect(page.getByRole("listitem").filter({ hasText: skus[0] })).toContainText("Model Phone A · Design Plain · Colour Blue");
    });
  } finally {
    await staff.close();
    await db.deliveryZone.deleteMany({ where: { marketId: "us", method } });
    await db.checkoutPolicy.update({ where: { marketId: "us" }, data: usPolicy });
    await db.$disconnect();
  }
});
