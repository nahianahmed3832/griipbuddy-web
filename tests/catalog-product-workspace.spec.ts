import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { getDb } from "../src/lib/db/client";

const root = "/staff/catalog";
const image = { src: "/catalog/phone-stand.webp", alt: "Catalog fixture image" };

test("connected product workspace authors sparse variants and publishes scoped catalog terms", async ({ page, baseURL }, info) => {
  test.skip(process.env.GRIIP_CATALOG_STAGE8_BROWSER !== "1", "Use the disposable product workspace profile.");
  const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  if (!baseURL || new URL(baseURL).hostname !== "127.0.0.1" || process.env.COMMERCE_MODE !== "local" ||
      database.hostname !== "127.0.0.1" || database.pathname !== "/griipbuddy_test" || database.search || !process.env.TEST_OWNER_PASSWORD) {
    throw new Error("Product workspace browser checks require a dedicated loopback database and staff fixtures.");
  }
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  const origin = new URL(baseURL).origin;
  await page.context().route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const prefix = `workspace-${randomUUID().slice(0, 8)}`;
  const id = `${prefix}-case`;
  const leaf = `${prefix}-protective`;
  const other = `${prefix}-travel`;
  const travel = `Travel ${prefix.slice(-6)}`;
  const attribute = `${prefix}-magnetic`;
  const name = "Canyon Protective Case";
  const warehouse = `${prefix}-warehouse`;
  const skus = [`${prefix}-ap`, `${prefix}-af`, `${prefix}-bp`].map(value => value.toUpperCase());
  const endpoint = "/api/staff/catalog";
  const headers = { origin };

  const login = await page.request.post("/api/staff/sign-in", { headers, data: { email: "owner@example.test", password: process.env.TEST_OWNER_PASSWORD } });
  expect(login.status()).toBe(200);
  async function command(action: string, input: object, status = 200) {
    const result = await page.request.post(endpoint, { headers, data: { action, input } });
    expect(result.status(), await result.text()).toBe(status);
    return (await result.json()).data;
  }
  for (const [categoryId, kind, parentId, name] of [[prefix, "DEPARTMENT", null, "Accessories"], [`${prefix}-cases`, "CATEGORY", prefix, "Cases"],
    [leaf, "SUBCATEGORY", `${prefix}-cases`, "Protective"], [other, "SUBCATEGORY", `${prefix}-cases`, travel]] as const) {
    await command("category.save", { id: categoryId, slug: categoryId, kind, parentId, name, shortName: name, revision: null,
      description: "Fixture category", state: "ACTIVE", position: 20, image });
  }
  await command("attribute.save", { id: attribute, name: "Magnetic mount", scope: "PRODUCT", dataType: "BOOLEAN" });
  await command("category.attribute", { departmentId: `${prefix}-cases`, attributeId: attribute, expectedRevision: 0,
    template: { required: true, filterable: true, position: 1, inheritable: true } });

  await page.goto(`${root}/products/new`);
  await expect(page.getByRole("heading", { name: "Create product", exact: true })).toBeVisible();
  const general = page.locator("#general:visible");
  await general.getByLabel("Product name").fill(name);
  await general.getByLabel("Product slug").fill(id);
  await general.getByLabel("Description", { exact: true }).fill("Protective case available in several model and design combinations.");
  await page.getByRole("combobox", { name: "Primary category", exact: true }).selectOption(leaf);
  const taxonomy = page.locator("#categories:visible");
  await taxonomy.locator("summary").filter({ hasText: "Additional categories" }).click();
  await taxonomy.getByRole("checkbox", { name: `Accessories / Cases / ${travel}`, exact: true }).check();
  await expect(taxonomy.getByText(/Inherited from Cases/)).toBeVisible();
  await taxonomy.getByRole("combobox", { name: /Magnetic mount/ }).selectOption({ label: "Yes" });

  for (const [axis, first, second] of [["Model", "Phone A", "Phone B"], ["Design", "Plain", "Floral"]]) {
    await page.getByRole("button", { name: "Add option", exact: true }).click();
    await page.getByLabel("Option label").last().fill(axis);
    const group = page.getByRole("group", { name: axis, exact: true });
    await group.getByLabel("Option key").fill(axis);
    await group.getByLabel("Canonical value").first().fill(first);
    await group.getByRole("button", { name: "Add option value" }).click();
    await group.getByLabel("Canonical value").last().fill(second);
  }
  await page.getByRole("button", { name: "Preview combinations" }).click();
  const combinations = ["Phone A / Plain", "Phone A / Floral", "Phone B / Plain"];
  for (const [index, options] of combinations.entries()) {
    await page.getByRole("checkbox", { name: `Include ${options}` }).check();
    await page.getByLabel(`SKU for ${options}`, { exact: true }).fill(skus[index]);
  }
  await expect(page.getByRole("checkbox", { name: "Include Phone B / Floral" })).not.toBeChecked();
  await page.getByRole("button", { name: "Add selected combinations" }).click();
  const saving = page.waitForResponse(response => response.url().endsWith(endpoint) &&
    response.request().method() === "POST" && response.request().postDataJSON()?.action === "product.save");
  await page.getByRole("button", { name: "Create draft" }).click();
  const created = await saving;
  expect(created.status(), await created.text()).toBe(200);
  const draft = created.request().postDataJSON().input as { variants: { id: string; sku: string }[] };
  expect(draft.variants.map(variant => variant.sku)).toEqual(skus);
  await expect(page).toHaveURL(new RegExp(`/products/${id}$`));
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish product" })).toBeDisabled();

  const media = page.locator("#media:visible");
  await media.getByRole("button", { name: "Add image" }).click();
  const asset = await readFile(new URL("../public/catalog/phone-stand.webp", import.meta.url));
  await media.getByLabel("Upload image 1").setInputFiles({ name: "fixture.webp", mimeType: "image/webp", buffer: asset });
  await expect(media.getByLabel("Image path 1")).toHaveValue(/^\/media\/[a-f0-9]{64}$/);
  const path = await media.getByLabel("Image path 1").inputValue();
  await media.getByLabel("Alternative text 1").fill("Shared case image");
  await media.getByRole("button", { name: "Save gallery" }).click();
  await expect(media.getByText("Shared gallery saved.")).toBeVisible();
  await media.getByRole("combobox", { name: "Gallery", exact: true }).selectOption(draft.variants[1].id);
  await expect(media.getByRole("heading", { name: "Shared image fallback" })).toBeVisible();
  await media.getByRole("button", { name: "Add image" }).click();
  await media.getByLabel("Image path 1").fill(path);
  await media.getByLabel("Alternative text 1").fill("Floral variant detail");
  await media.getByRole("button", { name: "Save gallery" }).click();
  await expect(media.getByText("Variant gallery saved.")).toBeVisible();

  for (const sku of skus.slice(0, 2)) await media.getByRole("checkbox", { name: new RegExp(sku) }).check();
  await media.getByLabel("Existing asset path").fill(`/media/${"0".repeat(64)}`);
  await media.getByLabel("Asset alternative text").fill("Unavailable fixture asset");
  await media.getByRole("button", { name: "Apply to 2 selected" }).click();
  await expect(media.getByText(/0 saved · 0 unchanged · 2 to review/)).toBeVisible();
  await media.getByRole("button", { name: "Reset bulk selection" }).click();
  await command("product.translation", { productId: id, revision: 0, locale: "en-US",
    content: { name: "Stale translation", description: "This stale form must not write." } }, 409);

  const price = (variantId: string, marketId: "bd" | "us", amountMinor: number) => command("offer.configure", {
    variantId, marketId, sellerId: "00000000-0000-4000-8000-000000000001", expectedRevision: null,
    currency: marketId === "bd" ? "BDT" : "USD", amountMinor, publication: "ACTIVE", eligible: false,
  });
  for (const variant of draft.variants.slice(1)) await price(variant.id, "bd", 139900);
  await page.reload();
  const offers = page.locator("#markets:visible");
  async function saveOffer(currency: string, amount: string) {
    await offers.getByRole("button", { name: `Add offer for ${skus[0]}` }).click();
    const form = offers.getByRole("form", { name: `Offer for ${skus[0]}` });
    await form.getByLabel("Offer seller").selectOption("00000000-0000-4000-8000-000000000001");
    await form.getByLabel("Offer status").selectOption("ACTIVE");
    await form.getByLabel(`Regular price (${currency})`).fill(amount);
    await form.getByRole("button", { name: "Save offer" }).click();
    await expect(offers.getByText(new RegExp(`Offer saved for ${skus[0]}`))).toBeVisible();
  }
  await saveOffer("BDT", "1399.00");
  await offers.getByRole("combobox", { name: "Offer and inventory market" }).selectOption("us");
  await expect(offers.getByRole("combobox", { name: "Offer and inventory market" })).toHaveValue("us");
  await saveOffer("USD", "23.99");
  await getDb().dispatchLocation.create({ data: { id: warehouse, name: "Shared fixture warehouse", marketId: "bd" } });
  await page.reload();
  const inventory = page.locator("#inventory:visible");
  async function switchMarket(market: "bd" | "us") {
    await offers.getByRole("combobox", { name: "Offer and inventory market" }).selectOption(market);
    await expect(offers.getByRole("combobox", { name: "Offer and inventory market" })).toHaveValue(market);
  }
  async function enableWarehouse(market: string) {
    await inventory.locator("summary").filter({ hasText: `Warehouse service for ${market}` }).click();
    await inventory.getByRole("combobox", { name: "Service warehouse" }).selectOption(warehouse);
    await inventory.getByRole("checkbox", { name: `Serve ${market}` }).check();
    await inventory.getByRole("button", { name: "Save warehouse service" }).click();
    await expect(inventory.getByText(`Warehouse service saved for ${market}.`)).toBeVisible();
  }
  await enableWarehouse("United States");
  await switchMarket("bd");
  await enableWarehouse("Bangladesh");
  await inventory.getByRole("combobox", { name: "Stock variant" }).selectOption(draft.variants[0].id);
  await inventory.getByRole("combobox", { name: "Stock warehouse" }).selectOption(warehouse);
  await inventory.getByRole("button", { name: "Open stock pool" }).click();
  const balance = inventory.getByRole("table", { name: "Physical stock pools" }).getByRole("row", { name: new RegExp(skus[0]) });
  await balance.getByRole("button", { name: "Record stock" }).click();
  const receipt = inventory.getByRole("form", { name: "Stock movement" });
  await receipt.getByLabel("Stock units").fill("3");
  await receipt.getByLabel("Movement reason").fill("Counted fixture receipt");
  await receipt.getByLabel("Movement reference").fill(prefix);
  await receipt.getByRole("button", { name: "Record movement" }).click();
  await expect(inventory.getByText("Stock movement recorded.")).toBeVisible();
  await expect(balance.getByRole("cell", { name: "3", exact: true })).toHaveCount(2);
  await switchMarket("us");
  await expect(balance).toHaveCount(1);
  await expect(balance.getByRole("cell", { name: "3", exact: true })).toHaveCount(2);
  await offers.getByRole("checkbox", { name: `Select ${skus[0]} offer` }).check();
  await command("offer.configure", { variantId: draft.variants[0].id, marketId: "us",
    sellerId: "00000000-0000-4000-8000-000000000001", expectedRevision: 0, currency: "USD", amountMinor: 2399,
    publication: "ACTIVE", eligible: false });
  await offers.getByRole("combobox", { name: "Bulk offer change" }).selectOption("browse");
  await offers.getByRole("button", { name: "Apply to selected offers" }).click();
  await expect(offers.getByText("0 of 1 offers saved")).toBeVisible();
  await expect(offers.getByText("The offer changed. Reload it before editing.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish product" })).toBeEnabled();
  await page.getByRole("button", { name: "Publish product" }).click();
  await expect(page.locator("#publication:visible").getByText("Published", { exact: true })).toBeVisible();
  for (const [market, expected] of [["bd", 139900], ["us", 2399]] as const) {
    const detail = await (await page.request.get(`/api/catalog/products/${id}?market=${market}`)).json();
    expect(detail.variants.find((variant: { id: string }) => variant.id === draft.variants[0].id).offer.amountMinor).toBe(expected);
    expect(detail.product.secondaryCategoryIds).toEqual([other]);
    if (market === "bd") expect(detail.variants.find((variant: { id: string }) => variant.id === draft.variants[1].id).image.alt).toBe("Floral variant detail");
  }

  await page.locator("#variants:visible").getByRole("checkbox", { name: `Select variant ${skus[1]}` }).check();
  await page.getByRole("button", { name: "Stage archive for selected" }).click();
  await page.getByRole("button", { name: "Save product", exact: true }).click();
  await expect(page.getByText("Product saved.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator("#variants:visible").getByRole("row", { name: new RegExp(skus[1]) })).toContainText("Archived");
  await expect(page.locator("#history:visible").getByText("Product publication changed", { exact: false })).toBeVisible();
  await expect(page.locator("#history:visible").getByText(/Product saved.*Title/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  if (process.env.GRIIP_PRODUCT_WORKSPACE_EVIDENCE) {
    const dir = process.env.GRIIP_PRODUCT_WORKSPACE_EVIDENCE;
    await mkdir(dir, { recursive: true });
    await page.locator("#variants:visible").evaluate(section => section.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: join(dir, `variants-${info.project.name}.png`), animations: "disabled" });
  }

  const simple = `${prefix}-stand`;
  const deviceNames = ["Fixture Phone A", "Fixture Phone B"];
  for (const [index, name] of deviceNames.entries()) await command("device.save", {
    id: `${prefix}-device-${index}`, brand: prefix, name, revision: null, aliases: [`${prefix}-alias-${index}`],
  });
  await page.goto(`${root}/products/new`);
  await general.getByLabel("Product name").fill("Universal fixture stand");
  await general.getByLabel("Product slug").fill(simple);
  await general.getByLabel("Description", { exact: true }).fill("One physical stand for several supported devices.");
  await taxonomy.getByRole("combobox", { name: "Primary category", exact: true }).selectOption(leaf);
  await taxonomy.getByRole("combobox", { name: "Magnetic mount" }).selectOption("false");
  const variants = page.locator("#variants:visible");
  await variants.getByLabel("Variant SKU").fill(simple.toUpperCase());
  await variants.getByRole("button", { name: "Add default variant" }).click();
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page).toHaveURL(new RegExp(`/products/${simple}$`));
  const fitment = page.locator("#compatibility:visible");
  for (const [index, name] of deviceNames.entries()) {
    await fitment.getByRole("searchbox", { name: "Search devices" }).fill(`${prefix}-alias-${index}`);
    await fitment.getByRole("button", { name: "Find devices" }).click();
    await fitment.getByRole("button", { name: `Link ${name}` }).click();
  }
  await fitment.getByRole("button", { name: "Save compatibility" }).click();
  await expect(fitment.getByText("Compatibility saved.")).toBeVisible();
  await page.reload();
  for (const name of deviceNames) await expect(fitment.getByRole("button", { name: `Remove ${name}` })).toBeVisible();
  await expect(variants.getByRole("table").getByRole("row", { name: new RegExp(simple.toUpperCase()) })).toHaveCount(1);
  await expect(page.locator("#history:visible").getByText("Device compatibility updated")).toBeVisible();

  await page.goto(`${root}?q=${simple.toUpperCase()}`);
  const listing = page.getByRole("link", { name: "Universal fixture stand", exact: true });
  await expect(listing).toBeVisible();
  await listing.focus();
  await expect(listing).toBeFocused();
  await listing.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/products/${simple}$`));
  await page.goto(`${root}/products/new?editor=legacy`);
  await expect(page.getByRole("heading", { name: "Create legacy product" })).toBeVisible();

  if (process.env.TEST_MARKET_PASSWORD) {
    const context = await page.context().browser()!.newContext({ baseURL });
    try {
      const staff = await context.request.post("/api/staff/sign-in", { headers, data: {
        email: "market@example.test", password: process.env.TEST_MARKET_PASSWORD,
      } });
      expect(staff.status()).toBe(200);
      for (const [marketId, status] of [["bd", 403], ["us", 200]] as const) {
        const response = await context.request.post("/api/staff/catalog/context", { headers, data: { marketId, permission: "commercial" } });
        expect(response.status()).toBe(status);
      }
      const denied = await context.request.post(endpoint, { headers, data: {
        action: "product.publish", input: { productId: simple, revision: 1 },
      } });
      expect(denied.status()).toBe(403);
    } finally {
      await context.close();
    }
  }
});
