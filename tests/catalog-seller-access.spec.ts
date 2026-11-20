import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { hashPassword } from "better-auth/crypto";
import { variantOptionSignature } from "../src/lib/catalog/option-signature";
import { getDb } from "../src/lib/db/client";
import { requireLocalDatabase } from "../src/lib/db/local";

const sellerCatalog = "/api/marketplace/seller/catalog";
const staffCatalog = "/api/staff/catalog";
const marketplace = "/api/marketplace";

test("seller dashboard enforces approved market and assigned offer ownership", async ({ page, browser, baseURL }, info) => {
  test.skip(process.env.GRIIP_CATALOG_SELLER_BROWSER !== "1", "Use the disposable seller-market browser fixture.");
  requireLocalDatabase("griipbuddy_test");
  const origin = baseURL && new URL(baseURL).origin;
  if (!origin || new URL(origin).hostname !== "127.0.0.1" || process.env.BETTER_AUTH_URL !== origin ||
      process.env.GRIIP_MARKETPLACE_PREVIEW !== "1" || process.env.GRIIP_FIRST_PARTY_STOREFRONT === "1") {
    throw new Error("Seller workspace verification requires a loopback Marketplace test profile.");
  }
  test.setTimeout(90_000);
  const db = getDb();
  const contexts: BrowserContext[] = [];
  const prefix = `seller-scope-${randomUUID().slice(0, 10)}`;
  const title = `Assigned catalog stand ${prefix}`;
  const root = `/seller/listings/${prefix}`;
  const password = randomUUID();
  const sellerA = { id: randomUUID(), email: `${prefix}-a@example.invalid`, name: "Fixture seller A" };
  const sellerB = { id: randomUUID(), email: `${prefix}-b@example.invalid`, name: "Fixture seller B" };
  const shoppers = [sellerA.email, sellerB.email, `${prefix}-applicant@example.invalid`];
  const ownerId = randomUUID();
  const scopedStaffId = randomUUID();
  const packerId = randomUUID();
  const staffIds = [ownerId, scopedStaffId, packerId];
  const firstVariant = `v-${prefix}-first`;
  const otherVariant = `v-${prefix}-other`;
  const variantIds = [firstVariant, otherVariant];
  const sku = firstVariant.toUpperCase();
  const warehouse = `${prefix}-warehouse`;
  const headers = { origin };
  const isolatedContext = async () => {
    const context = await browser.newContext({ baseURL, viewport: page.viewportSize(), isMobile: info.project.use.isMobile,
      hasTouch: info.project.use.hasTouch });
    contexts.push(context);
    await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    return context;
  };
  const post = async (client: APIRequestContext, path: string, data: object, status = 200, code?: string) => {
    const response = await client.post(path, { headers, data });
    expect(response.status(), `POST ${path}`).toBe(status);
    if (code) expect(await response.json()).toMatchObject({ error: { code } });
    return response;
  };
  const offer = (client: APIRequestContext, path: string, input: object, status = 200, code?: string) =>
    post(client, path, { action: "offer.configure", input }, status, code);
  const selectMarket = (client: APIRequestContext, region: string) => post(client, `${marketplace}/region`, { region });
  const bd = { variantId: firstVariant, marketId: "bd", currency: "BDT", publication: "ACTIVE", eligible: true };
  const us = { variantId: firstVariant, marketId: "us", currency: "USD", publication: "ACTIVE", eligible: false };

  try {
    await page.context().route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const buyer = await (await isolatedContext()).newPage();
    const competitor = await isolatedContext();
    const applicant = (await isolatedContext()).request;
    const passwordHash = await hashPassword(password);
    const [a, b, pending] = [randomUUID(), randomUUID(), randomUUID()];
    for (const [id, email, name, client] of [[a, sellerA.email, sellerA.name, page.request],
      [b, sellerB.email, sellerB.name, competitor.request], [pending, shoppers[2], "Fixture applicant", applicant]] as const) {
      await db.shopper.create({ data: { id, email, name, emailVerified: true,
        accounts: { create: { id: randomUUID(), providerId: "credential", accountId: id, password: passwordHash } },
      } });
      await post(client, "/api/shopper-auth/sign-in/email", { email, password });
    }
    const applicantId = randomUUID();
    const owner = (await isolatedContext()).request;
    const scopedStaff = (await isolatedContext()).request;
    const packer = (await isolatedContext()).request;
    for (const [id, access, client] of [[ownerId, "owner", owner], [scopedStaffId, "commercial", scopedStaff],
      [packerId, "packing", packer]] as const) {
      const email = `${id}@example.invalid`;
      await db.user.create({ data: { id, email, name: `Fixture ${access}`, emailVerified: true,
        staff: { create: { role: access === "owner" ? "OWNER" : "PACKER", ...(access !== "owner" && {
          marketGrants: { create: { marketId: "bd", commercial: access === "commercial", operations: true } },
        }) } }, accounts: { create: { id: randomUUID(), providerId: "credential", accountId: id, password: passwordHash } },
      } });
      await post(client, "/api/staff/sign-in", { email, password });
      await selectMarket(client, "bd");
    }
    await db.marketplaceShop.create({ data: { id: sellerA.id, ownerId: a, slug: `${prefix}-a`, name: sellerA.name,
      published: true, announcement: "", about: "", marketGrants: { create: { marketId: "bd", status: "APPROVED" } } } });
    await db.marketplaceShop.create({ data: { id: sellerB.id, ownerId: b, slug: `${prefix}-b`, name: sellerB.name,
      published: true, announcement: "", about: "", marketGrants: { create: (["bd", "us"] as const).map(marketId => ({
        marketId, status: "APPROVED",
      })) } } });
    await db.marketplaceShop.create({ data: { id: applicantId, ownerId: pending, slug: `${prefix}-pending`, name: "Fixture applicant",
      published: true, announcement: "", about: "", marketGrants: { create: { marketId: "bd", status: "PENDING" } } } });

    const department = await db.department.findFirstOrThrow({ select: { id: true } });
    await db.product.create({ data: { id: prefix, slug: prefix, departmentId: department.id, foundation: true, name: title,
      description: "Synthetic connected product for seller authorization checks", specifications: [], keywords: [], addedOn: new Date(),
      position: 0, publication: "ACTIVE", images: { create: { src: "/catalog/phone-stand.webp", alt: "Fixture stand", position: 0 } },
      optionDefinitions: { create: { id: "size", key: "size", label: "Size", position: 0, values: { create: [
        { id: "small", value: "small", label: "Small", position: 0 }, { id: "large", value: "large", label: "Large", position: 1 },
      ] } } },
    } });
    for (const [index, id] of variantIds.entries()) {
      const size = index === 0 ? "small" : "large";
      await db.variant.create({ data: { id, productId: prefix, label: size, sku: id.toUpperCase(), position: index, isDefault: index === 0,
        managedInventory: true, options: { size }, optionSignature: variantOptionSignature({ size }),
        optionSelections: { create: { optionId: "size", optionValueId: size } },
      } });
    }
    for (const [index, shopId] of [sellerA.id, sellerB.id].entries()) {
      const locationId = `${warehouse}-${index}`;
      await db.dispatchLocation.create({ data: { id: locationId, name: `Fixture warehouse ${index + 1}`, shopId,
        marketId: "bd", marketServices: { create: { marketId: "bd" } },
      } });
      await db.inventoryPool.create({ data: { variantId: firstVariant, locationId, ownerId: shopId, onHand: 4 } });
    }
    await offer(owner, staffCatalog, { ...bd, sellerId: sellerA.id, expectedRevision: null, amountMinor: 129900 });
    await offer(owner, staffCatalog, { ...bd, variantId: otherVariant, eligible: false, publication: "DRAFT",
      sellerId: sellerB.id, expectedRevision: null, amountMinor: 299900 });
    await selectMarket(owner, "us");
    await offer(owner, staffCatalog, { ...us, sellerId: sellerB.id, expectedRevision: null, amountMinor: 2499 });
    await selectMarket(owner, "bd");
    await selectMarket(page.request, "bd");
    await selectMarket(competitor.request, "bd");

    const visibleOffer = async (market: "bd" | "us", sellerId: string, amountMinor: number) => {
      const response = await buyer.request.get(`/api/catalog/products/${prefix}?market=${market}`);
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({ variants: [{ id: firstVariant, offer: { sellerId, amountMinor,
        currency: market === "bd" ? "BDT" : "USD" } }] });
    };
    await visibleOffer("bd", sellerA.id, 129900);
    await visibleOffer("us", sellerB.id, 2499);
    await page.goto("/seller");
    const assigned = page.getByRole("heading", { name: "Assigned catalog offers" }).locator("..");
    await assigned.getByRole("link", { name: "Manage offers and stock" }).click();
    await expect(page).toHaveURL(new RegExp(`/seller/listings/${prefix}$`));
    const offers = page.getByRole("table", { name: "Bangladesh offers" });
    await expect(offers.getByText(sku, { exact: false })).toBeVisible();
    await expect(offers.getByText(otherVariant.toUpperCase(), { exact: false })).toHaveCount(0);
    await expect(page.getByText("Fixture warehouse 2", { exact: false })).toHaveCount(0);
    await offers.getByRole("button", { name: `Edit offer for ${sku}` }).click();
    const form = page.getByRole("form", { name: `Offer for ${sku}` });
    await expect(form.getByLabel("Offer seller")).toHaveCount(0);
    await expect(form.getByLabel("Regular price (BDT)")).toHaveValue("1299.00");
    await form.getByLabel("Regular price (BDT)").fill("1599.00");
    const saved = page.waitForResponse(response => response.url().endsWith(sellerCatalog));
    await form.getByRole("button", { name: "Save offer" }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByText(`Offer saved for ${sku} in Bangladesh.`)).toBeVisible();
    await page.reload();
    await expect(offers.getByText(/1,599/)).toBeVisible();
    await visibleOffer("bd", sellerA.id, 159900);
    await buyer.goto(`/products/${prefix}?market=bd&variant=${firstVariant}`);
    await expect(buyer.getByRole("heading", { name: title })).toBeVisible();
    await expect(buyer.locator(".product-detail__price:visible")).toHaveText(/1,599/);
    const search = (market: string) => buyer.request.get(`/api/catalog/search?${new URLSearchParams({ market, q: sku })}`);
    expect(await (await search("bd")).json()).toMatchObject({ total: 1, items: [{ id: prefix, matchedVariantId: firstVariant }] });

    const edit = { ...bd, sellerId: sellerA.id, expectedRevision: 1, amountMinor: 999900 };
    await offer(competitor.request, sellerCatalog, edit, 403, "forbidden");
    await offer(competitor.request, sellerCatalog, { ...edit, sellerId: sellerB.id }, 403, "forbidden");
    await offer(applicant, sellerCatalog, { ...edit, sellerId: applicantId }, 403, "forbidden");
    await offer(packer, staffCatalog, edit, 403, "forbidden");
    await offer(scopedStaff, staffCatalog, { ...edit, sellerId: sellerB.id }, 403, "forbidden");
    await selectMarket(scopedStaff, "us");
    await offer(scopedStaff, staffCatalog, { ...us, sellerId: sellerB.id, expectedRevision: 0, amountMinor: 1999 }, 403, "forbidden");
    await offer(page.request, sellerCatalog, { ...us, sellerId: sellerA.id, expectedRevision: 0, amountMinor: 1999 }, 409, "market_mismatch");
    await selectMarket(page.request, "us");
    await page.reload();
    const market = page.getByLabel("Offer and inventory market");
    await expect(market.locator("option")).toHaveText(["Choose a market", "Bangladesh"]);
    await expect(page.getByText("Choose an approved market for this product.")).toBeVisible();
    await expect(page.getByRole("table", { name: "United States offers" })).toHaveCount(0);
    await offer(page.request, sellerCatalog, { ...us, sellerId: sellerA.id, expectedRevision: 0, amountMinor: 1999 }, 403, "forbidden");
    await market.selectOption("bd");
    await expect(offers).toBeVisible();
    await visibleOffer("bd", sellerA.id, 159900);

    await offer(owner, staffCatalog, { ...edit, sellerId: sellerB.id, amountMinor: 179900 });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await offer(page.request, sellerCatalog, { ...edit, expectedRevision: 2 }, 403, "forbidden");
    const otherSeller = await competitor.newPage();
    await otherSeller.goto(root);
    await expect(otherSeller.getByRole("table", { name: "Bangladesh offers" }).getByText(/1,799/)).toBeVisible();
    await visibleOffer("bd", sellerB.id, 179900);

    await post(owner, marketplace, { action: "staff-market-grant", shop: sellerB.id, marketId: "bd", status: "DENIED" });
    await otherSeller.reload();
    await expect(otherSeller.getByText("Choose an approved market for this product.")).toBeVisible();
    await expect(otherSeller.getByLabel("Offer and inventory market").locator("option")).toHaveText(["Choose a market", "United States"]);
    await offer(competitor.request, sellerCatalog, { ...edit, sellerId: sellerB.id, expectedRevision: 2 }, 403, "forbidden");
    expect((await buyer.request.get(`/api/catalog/products/${prefix}?market=bd`)).status()).toBe(404);
    expect(await (await search("bd")).json()).toMatchObject({ total: 0, items: [] });
    await buyer.reload();
    await expect(buyer.getByRole("heading", { name: "Product unavailable" })).toBeVisible();
    await visibleOffer("us", sellerB.id, 2499);
    expect(await (await search("us")).json()).toMatchObject({ total: 1, items: [{ id: prefix, matchedVariantId: firstVariant }] });
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    await db.$transaction(async tx => {
      await tx.inventoryPool.deleteMany({ where: { variantId: { in: variantIds } } });
      await tx.marketOffer.deleteMany({ where: { variantId: { in: variantIds } } });
      await tx.marketOfferIdentity.deleteMany({ where: { variantId: { in: variantIds } } });
      await tx.variant.deleteMany({ where: { id: { in: variantIds } } });
      await tx.product.deleteMany({ where: { id: prefix } });
      await tx.dispatchLocationMarket.deleteMany({ where: { locationId: { startsWith: warehouse } } });
      await tx.dispatchLocation.deleteMany({ where: { id: { startsWith: warehouse } } });
      await tx.marketplaceShop.deleteMany({ where: { slug: { startsWith: `${prefix}-` } } });
      await tx.shopper.deleteMany({ where: { email: { in: shoppers } } });
      await tx.auditEvent.deleteMany({ where: { OR: [{ target: { in: [...variantIds, sellerA.id, sellerB.id] } }, { actorId: { in: staffIds } }] } });
      await tx.user.deleteMany({ where: { id: { in: staffIds } } });
    });
    await db.$disconnect();
  }
});
