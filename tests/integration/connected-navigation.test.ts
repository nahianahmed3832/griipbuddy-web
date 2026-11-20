import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { markets } from "../../src/config/markets.ts";
import { prepareCategoryBrowseQuery } from "../../src/lib/catalog/category-browse-query.ts";
import {
  connectedCategoryDetail, connectedCategoryTree, connectedCollectionDetail, connectedCollections,
  connectedMarketMenu, resolveConnectedCategory,
} from "../../src/lib/catalog/connected-navigation.ts";
import { catalog } from "../../src/lib/catalog/repository.ts";
import { shoppingPreferenceDestination } from "../../src/lib/catalog/preference-destination.ts";
import { resolveDepartmentRedirect } from "../../src/lib/catalog/category-redirect.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { saveMarketMenu, setCuratedCollectionProducts } from "../../src/lib/staff/navigation.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

const image = { imageSrc: "/catalog/phone-stand.webp", imageAlt: "Catalog fixture" };
const categoryText = { description: "Catalog fixture description", name: "Technology", shortName: "Tech", ...image };
const productText = { name: "Travel case", description: "Case fixture", specifications: [], keywords: [], addedOn: new Date(), position: 0 };

test("connected category and menu reads honor locale, overrides, aliases and inherited templates", async () => {
  const key = `stage6-nav-${randomUUID().slice(0, 8)}`;
  const rootId = `${key}-root`;
  const casesId = `${key}-cases`;
  const othersId = `${key}-others`;
  const leafId = `${key}-leaf`;
  const archived = `${key}-archived`;
  const productId = `${key}-product`;
  const variantId = `v-${productId}`;
  const ownerId = `${key}-owner`;
  const ids = [rootId, casesId, othersId, leafId, archived];
  const attributeId = `${key}-material`;
  const oldSlug = `fundas-${key}`;
  const localizedSlug = `fundas-nuevas-${key}`;
  const bd = { marketId: "bd", locale: "es-US" } as const;
  const us = { marketId: "us", locale: "es-US" } as const;
  const privateImage = `/media/${"1".repeat(64)}`;

  try {
    await db.user.create({ data: { id: ownerId, name: "Navigation owner", email: `${ownerId}@example.test`,
      staff: { create: { role: "OWNER" } } } });
    await db.department.create({ data: { ...categoryText, id: rootId, slug: rootId, position: 0, kind: "DEPARTMENT" } });
    await db.department.create({ data: { ...categoryText, id: casesId, slug: casesId, parentId: rootId, position: 0,
      name: "Phone cases", shortName: "Cases", kind: "CATEGORY",
      translations: { create: { locale: "es-US", name: "Fundas de teléfono", shortName: "Fundas", description: "Protección", slug: localizedSlug } },
      slugAliases: { create: { locale: "es-US", slug: oldSlug } },
      marketPresentations: { create: { marketId: "bd", visibleInNavigation: false, position: 30,
        imageSrc: privateImage, imageAlt: "Private fixture photo" } },
    } });
    await db.department.create({ data: { ...categoryText, id: othersId, slug: othersId, parentId: rootId, position: 1, kind: "CATEGORY" } });
    await db.department.create({ data: { ...categoryText, id: leafId, slug: leafId, parentId: casesId, position: 0, kind: "SUBCATEGORY" } });
    await db.department.create({ data: { ...categoryText, id: archived, slug: archived, parentId: casesId, position: 1,
      kind: "SUBCATEGORY", state: "ARCHIVED" } });
    await db.catalogAttributeDefinition.create({ data: { id: attributeId, name: "Material", scope: "PRODUCT", dataType: "ENUM",
      allowedValues: ["silicone", "leather"], templates: { create: { departmentId: casesId, inheritable: true, filterable: true } },
    } });
    await db.product.create({ data: { ...productText, id: productId, slug: productId, departmentId: leafId, publication: "ACTIVE",
      variants: { create: { id: variantId, sku: productId, label: "Standard", position: 0, options: {}, inventory: { create: { available: 2 } },
        offers: { create: { marketId: "bd", currency: "BDT", amountMinor: 12_500 } },
      } },
    } });
    const items = [{ type: "category", categoryId: leafId }, { type: "page", page: "SHOP" }];
    await saveMarketMenu(ownerId, { marketId: "bd", key, expectedRevision: null, items });
    await saveMarketMenu(ownerId, { marketId: "us", key, expectedRevision: null, items });

    const bdRoot = (await connectedCategoryTree(bd)).categories.find(category => category.id === rootId);
    const usRoot = (await connectedCategoryTree(us)).categories.find(category => category.id === rootId);
    assert.deepEqual(bdRoot?.children.map(({ id }) => id), [othersId, casesId]);
    assert.deepEqual(usRoot?.children.map(({ id }) => id), [casesId, othersId]);
    assert.equal(bdRoot?.children[1].children[0].visibleInNavigation, false);
    assert.equal(bdRoot?.children[1].image.src, "/editorial/hero.webp");
    assert.equal(usRoot?.children[0].image.src, image.imageSrc);

    const detail = await connectedCategoryDetail(oldSlug, bd);
    assert.equal(detail?.category.id, casesId);
    assert.equal(detail?.category.name, "Fundas de teléfono");
    assert.equal(detail?.redirectSlug, localizedSlug);
    assert.equal(await resolveDepartmentRedirect(localizedSlug, "bd", "es-US"), null);
    assert.equal(await resolveDepartmentRedirect(oldSlug, "bd", "es-US"), localizedSlug);
    assert.deepEqual(detail?.ancestors.map(({ id }) => id), [rootId]);
    assert.deepEqual(detail?.descendantCategoryIds, [leafId]);
    assert.deepEqual((await resolveConnectedCategory(casesId, "bd", "es-US"))?.descendants.map(({ id }) => id).sort(), [casesId, leafId].sort());
    assert.equal(await connectedCategoryDetail(archived, bd), null);
    const leaf = await connectedCategoryDetail(leafId, bd);
    assert.equal(leaf?.attributes[0].sourceDepartmentId, casesId);
    assert.deepEqual(leaf?.attributes[0].allowedValues, ["silicone", "leather"]);
    assert.equal(leaf?.attributes[0].filterable, true);
    assert.equal(new URL(leaf!.productsHref, "http://localhost").searchParams.get("category"), leafId);

    assert.deepEqual((await connectedMarketMenu(key, bd))?.items.map(({ label }) => label), ["Tienda"]);
    const usMenu = await connectedMarketMenu(key, us);
    assert.deepEqual(usMenu?.items.map(({ label }) => label), ["Tech", "Tienda"]);
    for (const item of usMenu?.items ?? []) {
      const target = new URL(item.href, "http://127.0.0.1");
      assert.equal(target.searchParams.get("market"), "us");
      assert.equal(target.searchParams.get("lang"), "es-US");
    }
    assert.equal((await catalog.getProduct(productId, "bd"))?.variants[0].offer?.stock, 2);
    const settings = process.env.GRIIP_MARKET_CONFIGURATION;
    const overlay = JSON.parse(settings ?? "{}");
    try {
      process.env.GRIIP_MARKET_CONFIGURATION = JSON.stringify({
        ...overlay,
        bd: { ...overlay.bd, defaultLocale: "en-BD", languages: ["en-BD"] },
        us: { ...overlay.us, defaultLocale: "en-US", languages: ["en-US", "es-US"] },
      });
      const newMarket = { marketId: "bd", locale: "en-BD", fromMarketId: "us", fromLocale: "es-US" };
      const source = `/departments/${localizedSlug}?color=Blue&minMinor=1999&cursor=reset-me&page=2`;
      const switched = await shoppingPreferenceDestination({ ...newMarket, path: source });
      const target = new URL(switched!.href, "http://127.0.0.1");
      assert.ok(target.pathname.endsWith(`/departments/${casesId}`));
      assert.equal(target.searchParams.get("browseFrom"), "us");
      assert.equal(target.searchParams.get("market"), "bd");
      assert.equal(target.searchParams.get("lang"), "en-BD");
      assert.equal(target.searchParams.get("color"), "Blue");
      assert.equal(target.searchParams.get("minMinor"), "1999"); // The category listing owns localized filter validation.
      assert.equal(target.searchParams.has("cursor"), false);
      assert.equal(target.searchParams.has("page"), false);

      const search = await shoppingPreferenceDestination({ ...newMarket, path:
        "/search?q=Phone+B&model=Phone+B&sort=price-low&minMinor=1999&country=US&district=wa&method=ground&paymentMethod=COD&cursor=reset-me&page=2" });
      const searchTarget = new URL(search!.href, "http://127.0.0.1");
      const preparedSearch = prepareCategoryBrowseQuery(Object.fromEntries(searchTarget.searchParams), markets.bd, {});
      assert.ok(searchTarget.pathname.endsWith("/search"));
      assert.equal(searchTarget.searchParams.get("browseFrom"), "us");
      assert.equal(searchTarget.searchParams.has("cursor"), false);
      assert.equal(searchTarget.searchParams.has("page"), false);
      assert.equal(preparedSearch.params.get("q"), "Phone B");
      assert.equal(preparedSearch.params.get("model"), "Phone B");
      assert.equal(preparedSearch.params.get("sort"), "price-low");
      assert.equal(preparedSearch.params.has("minMinor"), false);
      assert.equal(preparedSearch.delivery, undefined);
      assert.deepEqual(preparedSearch.removed, ["Price", "Delivery"]);

      const unavailable = await shoppingPreferenceDestination({ ...newMarket, path: `/departments/${archived}?color=Blue` });
      const fallback = new URL(unavailable!.href, "http://127.0.0.1");
      assert.ok(fallback.pathname.endsWith("/shop"));
      assert.equal(fallback.searchParams.get("catalogUnavailable"), "category");
      assert.equal(fallback.searchParams.has("color"), false);
      for (const unsafe of ["//example.invalid", "/.//example.invalid", "https://example.invalid"]) {
        assert.equal(await shoppingPreferenceDestination({ ...newMarket, path: unsafe }), null);
      }
    } finally {
      if (settings === undefined) delete process.env.GRIIP_MARKET_CONFIGURATION;
      else process.env.GRIIP_MARKET_CONFIGURATION = settings;
    }
    await db.departmentMarketPresentation.update({ where: { departmentId_marketId: { departmentId: casesId, marketId: "bd" } },
      data: { visibleInNavigation: true } });
    assert.deepEqual((await connectedMarketMenu(key, bd))?.items.map(({ label }) => label), ["Tech", "Tienda"]);
    assert.equal(await connectedMarketMenu(`${key}-missing`, bd), null);
  } finally {
    await db.marketMenu.deleteMany({ where: { key } });
    await db.auditEvent.deleteMany({ where: { actorId: ownerId } });
    await db.user.deleteMany({ where: { id: ownerId } });
    await db.marketOffer.deleteMany({ where: { variantId } });
    await db.inventory.deleteMany({ where: { variantId } });
    await db.variant.deleteMany({ where: { id: variantId } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.categoryAttributeTemplate.deleteMany({ where: { attributeId } });
    await db.catalogAttributeDefinition.deleteMany({ where: { id: attributeId } });
    await db.departmentSlugAlias.deleteMany({ where: { departmentId: { in: ids } } });
    await db.departmentTranslation.deleteMany({ where: { departmentId: { in: ids } } });
    await db.departmentMarketPresentation.deleteMany({ where: { departmentId: { in: ids } } });
    for (const id of [...ids].reverse()) await db.department.deleteMany({ where: { id } });
  }
});

test("connected collection metadata keeps curated and rule membership in the shared product queries", async () => {
  const id = `stage6-collections-${randomUUID().slice(0, 8)}`;
  const curated = `${id}-manual`;
  const featured = `${id}-featured`;
  const productId = `${id}-product`;
  const ownerId = `${id}-owner`;
  const variantId = `v-${productId}`;
  const context = { marketId: "us", locale: "en-US" } as const;

  try {
    await db.user.create({ data: { id: ownerId, name: "Collection owner", email: `${ownerId}@example.test`,
      staff: { create: { role: "OWNER" } } } });
    await db.department.create({ data: { ...categoryText, id, slug: id, position: 0 } });
    await db.collection.createMany({ data: [
      { id: curated, slug: `${id}-travel`, position: 7, name: "Travel selects", description: "Handpicked items", ...image },
      { id: featured, slug: featured, position: 5, name: "Featured", description: "Highlights", selection: "FEATURED" },
    ] });
    await db.product.create({ data: { ...productText, id: productId, slug: productId, departmentId: id,
      publication: "ACTIVE", featured: true,
      variants: { create: { id: variantId, sku: productId, label: "Standard", position: 0, options: {},
        offers: { create: { marketId: "us", currency: "USD", amountMinor: 1_900 } },
      } },
    } });
    await setCuratedCollectionProducts(ownerId, { collectionId: curated, expectedProductIds: [], productIds: [productId] });

    const collections = (await connectedCollections(context)).collections.filter(row => [featured, curated].includes(row.id));
    assert.deepEqual(collections.map(({ id, selection }) => [id, selection]), [[featured, "FEATURED"], [curated, "CURATED"]]);
    const bySlug = await connectedCollectionDetail(`${id}-travel`, context);
    assert.equal(bySlug?.collection.id, curated);
    assert.equal(bySlug?.collection.image?.src, image.imageSrc);
    const href = new URL(bySlug!.collection.productsHref, "http://localhost");
    assert.equal(href.searchParams.get("collection"), curated);
    assert.equal(href.searchParams.get("market"), context.marketId);
    assert.deepEqual(await connectedCollectionDetail(curated, context), bySlug);
    assert.equal(await connectedCollectionDetail(`${id}-missing`, context), null);
    for (const collectionId of [featured, curated]) {
      const products = await catalog.listProducts({ marketId: "us", collectionId, productIds: [productId] });
      assert.deepEqual(products.map(product => product.id), [productId]);
      assert.deepEqual(await catalog.listProducts({ marketId: "bd", collectionId, productIds: [productId] }), []);
    }
  } finally {
    await db.collection.deleteMany({ where: { id: { in: [featured, curated] } } });
    await db.auditEvent.deleteMany({ where: { actorId: ownerId } });
    await db.user.deleteMany({ where: { id: ownerId } });
    await db.marketOffer.deleteMany({ where: { variantId } });
    await db.variant.deleteMany({ where: { id: variantId } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.department.deleteMany({ where: { id } });
  }
});
