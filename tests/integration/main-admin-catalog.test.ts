import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { hashPassword } from "better-auth/crypto";
import "../../scripts/load-env.ts";
import { GET as legacyAssignments } from "../../src/app/api/staff/catalog/assignments/route.ts";
import { GET as legacyAttributes, POST as legacyAttributeImpact } from "../../src/app/api/staff/catalog/attribute-impact/route.ts";
import { GET as legacyCategoryImpact } from "../../src/app/api/staff/catalog/category-impact/route.ts";
import { GET as legacyCollectionProducts } from "../../src/app/api/staff/catalog/collection-products/route.ts";
import { GET as legacyDeviceModels } from "../../src/app/api/staff/catalog/device-models/route.ts";
import { handleMainAdminCatalog } from "../../src/lib/catalog/main-admin-api.ts";
import { retiredCatalogApiResponse, retiredCatalogBrowserResponse } from "../../src/lib/catalog/main-admin-browser.ts";
import { requireLegacyCatalogBrowser } from "../../src/lib/catalog/main-admin-config.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { shopperAuth } from "../../src/lib/marketplace/auth.ts";
import { staffAuth } from "../../src/lib/staff/auth.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

const prefix = `main-admin-${randomUUID().slice(0, 8)}`;
const adminOrigin = "http://127.0.0.1:4361";
const signatureKey = randomBytes(48).toString("hex");
const password = randomBytes(32).toString("hex");
const owner = { legacyId: randomBytes(12).toString("hex"), id: `${prefix}-owner`, role: "OWNER" } as const;
const marketStaff = { legacyId: randomBytes(12).toString("hex"), id: `${prefix}-market`, role: "PACKER" } as const;
const staff = [owner, marketStaff];
const market = "bd";
const mediaSource = "/catalog/phone-stand.webp";

function signed(operation: object, overrides: object = {}, options?: { tampered?: boolean; origin?: string }) {
  const body = JSON.stringify({ issuedAt: Date.now(), nonce: randomUUID(), legacyId: owner.legacyId, central: true,
    marketId: market, request: operation, ...overrides });
  const signature = createHmac("sha256", signatureKey).update("griip-main-admin-catalog-v1\n").update(body).digest("hex");
  return () => handleMainAdminCatalog(new Request("http://127.0.0.1:3100/api/internal/main-admin-catalog", {
    method: "POST",
    headers: { "content-type": "application/json", "x-griip-catalog-signature": signature,
      ...(options?.origin && { origin: options.origin }) },
    body: options?.tampered ? body.replace('"central":true', '"central":false') : body,
  }));
}

async function checked(response: Response, status: number, code?: string) {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  if (code) assert.equal(body.error?.code, code);
  return body;
}

test("configured bridge authenticates the signed body, preserves authority, and retires only the moved browser routes", async t => {
  const config = {
    GRIIP_MARKETPLACE_PREVIEW: "1",
    GRIIP_MAIN_ADMIN_CATALOG_ORIGIN: adminOrigin,
    GRIIP_MAIN_ADMIN_CATALOG_SECRET: signatureKey,
    GRIIP_MAIN_ADMIN_CATALOG_ACTORS: JSON.stringify(Object.fromEntries(staff.map(actor => [actor.legacyId, actor.id]))),
    SHOPPER_AUTH_SECRET: randomBytes(48).toString("hex"),
  };
  const previous = Object.keys(config).map(name => [name, process.env[name]] as const);
  Object.assign(process.env, config);
  const createdCategory = `${prefix}-category`;
  const branch = `${prefix}-branch`;
  const leaf = `${prefix}-leaf`;
  const productId = `${prefix}-product`;
  const variantId = `v-${productId}`;
  const oldProductId = `${prefix}-old-product`;
  const oldProductSlug = `${prefix}-old-slug`;
  const sourceProductId = randomBytes(12).toString("hex");
  const sourceCategoryId = randomBytes(12).toString("hex");
  const runId = randomBytes(32).toString("hex");
  const warehouseId = randomUUID();
  const uploads: string[] = [];
  const shopperEmail = `${prefix}-shopper@example.invalid`;
  t.after(async () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await db.auditEvent.deleteMany({ where: { target: { startsWith: prefix } } });
    await db.auditEvent.deleteMany({ where: { target: warehouseId } });
    await db.dispatchLocation.deleteMany({ where: { id: warehouseId } });
    await db.departmentMarketPresentation.deleteMany({ where: { departmentId: createdCategory } });
    await db.catalogMigrationMapping.deleteMany({ where: { runId } });
    await db.catalogMigrationRun.deleteMany({ where: { id: runId } });
    await db.catalogMigrationRedirect.deleteMany({ where: { slug: oldProductSlug } });
    await db.variant.deleteMany({ where: { id: variantId } });
    await db.product.deleteMany({ where: { id: { in: [oldProductId, productId] } } });
    for (const id of [leaf, branch, createdCategory]) await db.department.deleteMany({ where: { id } });
    await db.catalogMedia.deleteMany({ where: { id: { in: uploads } } });
    await db.shopper.deleteMany({ where: { email: shopperEmail } });
    await db.user.deleteMany({ where: { id: { in: staff.map(actor => actor.id) } } });
  });
  const hash = await hashPassword(password);
  for (const actor of staff) {
    await db.user.create({ data: {
      id: actor.id, email: `${actor.id}@example.invalid`, name: "Catalog test staff", emailVerified: true,
      accounts: { create: { id: randomUUID(), providerId: "credential", accountId: actor.id, password: hash } },
      staff: { create: { role: actor.role, ...(actor.role === "PACKER" && {
        marketGrants: { create: { marketId: "bd", merchandising: true, commercial: true } },
      }) } },
    } });
  }

  const query = { read: "products" };
  delete process.env.GRIIP_MAIN_ADMIN_CATALOG_SECRET;
  await checked(await signed(query)(), 404, "not_found");
  process.env.GRIIP_MAIN_ADMIN_CATALOG_SECRET = signatureKey;
  await checked(await signed(query, {}, { tampered: true })(), 401, "authentication_required");
  await checked(await signed(query, {}, { origin: adminOrigin })(), 401, "authentication_required");
  await checked(await signed(query, { issuedAt: Date.now() - 61_000 })(), 401, "expired_request");
  await checked(await signed(query, { issuedAt: Date.now() + 61_000 })(), 401, "expired_request");
  await checked(await signed(query, { legacyId: randomBytes(12).toString("hex") })(), 403, "forbidden");
  await checked(await signed(query, { legacyId: marketStaff.legacyId })(), 403, "forbidden");
  const marketActor = { legacyId: marketStaff.legacyId, central: false };
  await checked(await signed(query, { ...marketActor, marketId: "us" })(), 403, "forbidden");
  await checked(await signed(query, marketActor)(), 200);
  await checked(await signed({ read: "asset", id: mediaSource }, marketActor)(), 403, "forbidden");

  const create = { action: "category.save", input: {
    id: createdCategory, slug: createdCategory, kind: "DEPARTMENT", parentId: null, state: "ACTIVE", revision: null,
    name: "Main admin catalog test", shortName: "Catalog test", description: "",
    image: { src: mediaSource, alt: "Catalog fixture" }, position: 0,
  } };
  await checked(await signed(create, marketActor)(), 403, "forbidden");
  const replay = signed(create);
  const results = await Promise.all([replay(), replay()]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  await checked(results.find(result => result.status === 409)!, 409, "replayed_request");
  const taxonomy = await checked(await signed({ read: "categories", id: createdCategory })(), 200);
  assert.equal(taxonomy.data.selectedId, createdCategory);
  assert.equal(taxonomy.data.attributes.category.id, createdCategory);
  assert.equal(taxonomy.data.assignments.categoryId, createdCategory);
  assert.equal(taxonomy.data.history[0].action, "TAXONOMY_SAVED");
  const scoped = await checked(await signed({ read: "categories", id: createdCategory }, marketActor)(), 200);
  assert.equal(scoped.data.attributes, null);
  assert.equal(scoped.data.assignments, null);
  assert.deepEqual(scoped.data.history, []);
  assert.deepEqual(scoped.data.markets, ["bd"]);
  await checked(await signed({ action: "category.presentation", input: {
    id: createdCategory, revision: 0, marketId: "us", presentation: { visibleInNavigation: false },
  } }, marketActor)(), 409, "market_mismatch");
  await checked(await signed({ action: "category.presentation", input: {
    id: createdCategory, revision: 0, marketId: "bd", presentation: { visibleInNavigation: false },
  } }, marketActor)(), 200);
  assert.equal((await db.departmentMarketPresentation.findUniqueOrThrow({
    where: { departmentId_marketId: { departmentId: createdCategory, marketId: "bd" } },
  })).visibleInNavigation, false);
  for (const [id, kind, parentId] of [[branch, "CATEGORY", createdCategory], [leaf, "SUBCATEGORY", branch]]) {
    await checked(await signed({ ...create, input: { ...create.input, id, slug: id, kind, parentId } })(), 200);
  }
  await checked(await signed({ action: "product.save", input: {
    id: productId, slug: productId, primaryCategoryId: leaf, expectedRevision: null, name: "Main admin catalog fixture",
    description: "A connector test product with one stable SKU.", publication: "DRAFT", options: [],
    variants: [{ id: variantId, sku: productId.toUpperCase(), selections: {} }],
  } })(), 200);
  await db.product.create({ data: {
    id: oldProductId, slug: oldProductSlug, departmentId: leaf, name: "Old product reference", description: "", active: false,
    specifications: [], addedOn: new Date(), position: 0,
  } });
  await db.catalogMigrationRun.create({ data: { id: runId, version: "main-admin-test", status: "COMPLETED", expectedBatches: 1 } });
  await db.catalogMigrationMapping.createMany({ data: [
    { runId, sourceSystem: "recovered-mongo", entity: "product", sourceId: sourceProductId, targetId: productId },
    { runId, sourceSystem: "native-postgres", entity: "product", sourceId: oldProductId, targetId: productId },
    { runId, sourceSystem: "recovered-mongo", entity: "category", sourceId: sourceCategoryId, targetId: leaf },
    { runId, sourceSystem: "recovered-mongo", entity: "category-code:sample", sourceId: "ACCESS.1", targetId: leaf },
  ] });
  await db.catalogMigrationRedirect.create({ data: { sourceProductId: oldProductId, slug: oldProductSlug, productId } });
  for (const id of [productId, sourceProductId, oldProductSlug, oldProductId]) {
    const product = await checked(await signed({ read: "product", id })(), 200);
    assert.equal(product.data.identity.product.id, productId);
    assert.equal(product.data.shared.variants[0].id, variantId);
  }
  const resultsForProduct = await checked(await signed({ read: "products", q: prefix })(), 200);
  assert.deepEqual(resultsForProduct.data.rows.map((row: { id: string }) => row.id), [productId]);
  await checked(await signed({ read: "product", id: "main-admin-catalog-fixture" })(), 404, "not_found");
  const mapped = await checked(await signed({ read: "categories", id: sourceCategoryId })(), 200);
  assert.equal(mapped.data.selectedId, leaf);
  assert.deepEqual(mapped.data.businessCodes, [{ namespace: "sample", value: "ACCESS.1" }]);
  await checked(await signed({ read: "product", id: "new" })(), 200);
  await checked(await signed({ read: "inventory" })(), 200);
  await checked(await signed({ read: "warehouses" }, marketActor)(), 403, "forbidden");
  const warehouse = { action: "inventory.warehouse.create", input: {
    id: warehouseId, name: `${prefix} dispatch`, shopId: null, marketId: "bd", priority: 45,
  } };
  await checked(await signed(warehouse, marketActor)(), 403, "forbidden");
  await checked(await signed({ ...warehouse, input: { ...warehouse.input, marketId: "us" } })(), 409, "market_mismatch");
  await checked(await signed({ ...warehouse, input: { ...warehouse.input, shopId: randomUUID() } })(), 422, "rule_violation");
  const createdWarehouses = await Promise.all([signed(warehouse)(), signed(warehouse)()]);
  for (const response of createdWarehouses) assert.deepEqual((await checked(response, 200)).data, { id: warehouseId });
  await checked(await signed({ ...warehouse, input: { ...warehouse.input, priority: 46 } })(), 409, "conflict");
  assert.equal(await db.auditEvent.count({ where: { target: warehouseId, action: "MARKET_SETTINGS_CHANGED" } }), 1);
  assert.equal(await db.inventoryPool.count({ where: { locationId: warehouseId } }), 0);
  const warehouseList = await checked(await signed({ read: "warehouses" })(), 200);
  assert.equal(warehouseList.data.locations.filter((row: { id: string }) => row.id === warehouseId).length, 1);

  const image = await readFile("public" + mediaSource);
  const bundled = await checked(await signed({ read: "asset", id: mediaSource })(), 200);
  assert.equal(bundled.data.data, image.toString("base64"));
  const { default: sharp } = await import("sharp");
  const pixel = randomBytes(3);
  const uploadedBytes = await sharp(pixel, { raw: { width: 1, height: 1, channels: 3 } }).png().toBuffer();
  const uploaded = await checked(await signed({ action: "media.upload",
    input: { mime: "image/png", data: uploadedBytes.toString("base64") } })(), 201);
  uploads.push(uploaded.data.src.slice(7));
  assert.equal((await db.catalogMedia.findUniqueOrThrow({ where: { id: uploads[0] } })).editorial, false);
  const editorialUpload = { action: "media.upload", input: { mime: "image/png", data: uploadedBytes.toString("base64"), purpose: "editorial" } };
  await checked(await signed(editorialUpload, marketActor)(), 403, "forbidden");
  const editorial = await checked(await signed(editorialUpload)(), 201);
  assert.equal(editorial.data.src, uploaded.data.src);
  assert.equal((await db.catalogMedia.findUniqueOrThrow({ where: { id: uploads[0] } })).editorial, true);
  const asset = await checked(await signed({ read: "asset", id: uploaded.data.src })(), 200);
  assert.equal(asset.data.contentType, "image/webp");
  assert.ok(asset.data.data.length > 0);

  const storefront = new URL(process.env.BETTER_AUTH_URL!).origin;
  async function staffCookie(id: string) {
    const login = await staffAuth().handler(new Request(new URL("/api/staff/sign-in/email", storefront), {
      method: "POST", headers: { origin: storefront, "content-type": "application/json" },
      body: JSON.stringify({ email: `${id}@example.invalid`, password }),
    }));
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    assert.ok(cookie);
    return cookie;
  }
  const cookie = await staffCookie(owner.id);
  const marketCookie = await staffCookie(marketStaff.id);
  function retired(path: string, method = "GET", session: string | null = cookie) {
    const url = new URL(path, storefront);
    return retiredCatalogBrowserResponse(new Request(url, { method, headers: session ? { cookie: session } : {} }), url);
  }
  assert.equal((await retired("/staff/catalog", "GET", null))?.status, 401);
  const shopperRoute = (action: "sign-up" | "sign-in") => shopperAuth().handler(
    new Request(new URL(`/api/shopper-auth/${action}/email`, storefront), {
      method: "POST", headers: { origin: storefront, "content-type": "application/json" },
      body: JSON.stringify({ name: "Synthetic storefront shopper", email: shopperEmail, password }),
    }),
  );
  assert.equal((await shopperRoute("sign-up")).status, 200);
  const shopperLogin = await shopperRoute("sign-in");
  assert.equal(shopperLogin.status, 200);
  const shopperCookie = shopperLogin.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
  assert.ok(shopperCookie);
  assert.equal((await retired("/staff/catalog", "GET", shopperCookie))?.status, 401);
  const old = await retired(`/staff/catalog/taxonomy?category=${createdCategory}&view=navigation&market=us&next=https://example.invalid`);
  assert.equal(old?.status, 307);
  assert.equal(old.headers.get("location"),
    `${adminOrigin}/admin/dashboard/categories?region=INTERNATIONAL&category=${createdCategory}&view=menus`);
  const oldCreate = await retired("/staff/catalog/taxonomy?category=new");
  assert.equal(oldCreate?.status, 307);
  assert.equal(oldCreate.headers.get("location"), `${adminOrigin}/admin/dashboard/categories?region=BD&mode=create`);
  assert.equal((await retired("/staff/catalog/taxonomy?category=new&view=categories", "HEAD", marketCookie))?.status, 403);
  const inventory = await retired("/staff/catalog/inventory?q=fixture");
  assert.equal(inventory?.headers.get("location"),
    `${adminOrigin}/admin/dashboard/check-outlet-stocks?region=BD&catalog=connected&q=fixture`);
  assert.equal((await retired("/staff/catalog", "HEAD", marketCookie))?.status, 307);
  assert.equal((await retired("/staff/catalog?market=us", "GET", marketCookie))?.status, 403);
  assert.equal((await retired("/staff/catalog/products/new", "GET", marketCookie))?.status, 403);
  assert.equal((await retired("/staff/catalog/taxonomy/legacy", "GET", marketCookie))?.status, 403);
  assert.equal((await retired("/staff/catalog/products/new", "POST"))?.status, 410);
  assert.equal((await retired("/api/staff/%63atalog", "POST"))?.status, 410);
  assert.equal((await retired("/api/staff/product-image", "POST"))?.status, 410);
  assert.equal(await retired("/api/staff/catalog-image", "POST"), undefined);
  assert.equal(await retired("/api/marketplace/seller/catalog", "POST"), undefined);
  assert.equal(await retired("/api/staff/catalog-import", "POST"), undefined);
  assert.equal(await retired("/staff/catalog/feeds"), undefined);
  assert.equal(await retired("/staff/catalog/merchandising"), undefined);
  assert.equal(await retired("/staff/orders/fixture-order"), undefined);

  for (const [path, handler, method = "GET"] of [
    ["assignments", legacyAssignments], ["attribute-impact", legacyAttributes], ["attribute-impact", legacyAttributeImpact, "POST"],
    ["category-impact", legacyCategoryImpact], ["collection-products", legacyCollectionProducts], ["device-models", legacyDeviceModels],
  ] as const) {
    const url = new URL(`/api/staff/catalog/${path}`, storefront);
    for (const [session, expected] of [[null, 401], [shopperCookie, 401], [cookie, 410]] as const) {
      const response = await handler(new Request(url, { method, headers: session ? { cookie: session } : {} }));
      assert.equal(response.status, expected);
      assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    }
  }

  process.env.GRIIP_MAIN_ADMIN_CATALOG_ACTORS = JSON.stringify({ [marketStaff.legacyId]: marketStaff.id });
  assert.equal((await retired("/staff/catalog"))?.status, 403);

  process.env.GRIIP_MAIN_ADMIN_CATALOG_ACTORS = "not-json";
  const unavailable = await retired("/staff/catalog/taxonomy");
  assert.equal(unavailable?.status, 503);
  assert.equal(unavailable?.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(unavailable?.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal((await retired("/staff/catalog/products/new", "GET", null))?.status, 401);
  assert.equal((await retired("/staff/catalog/products/new", "POST"))?.status, 410);
  assert.throws(requireLegacyCatalogBrowser, /main GriipBuddy admin/);
  assert.equal(await retired("/api/marketplace/seller/catalog", "POST"), undefined);
  assert.equal(await retired("/staff/orders/fixture-order"), undefined);

  delete process.env.GRIIP_MAIN_ADMIN_CATALOG_ACTORS;
  delete process.env.GRIIP_MAIN_ADMIN_CATALOG_SECRET;
  const legacyApi = new Request(new URL("/api/staff/catalog/context", storefront), { method: "POST", headers: { cookie } });
  assert.equal((await retiredCatalogApiResponse(legacyApi))?.status, 410);
  delete process.env.GRIIP_MAIN_ADMIN_CATALOG_ORIGIN;
  assert.equal(await retired("/staff/catalog"), undefined);
  assert.equal(await retiredCatalogApiResponse(legacyApi), undefined);
  assert.doesNotThrow(requireLegacyCatalogBrowser);

  Object.assign(process.env, config);
  await db.staffAccess.update({ where: { userId: marketStaff.id }, data: { active: false } });
  await checked(await signed(query, marketActor)(), 403, "forbidden");
});
