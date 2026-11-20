import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { expect, test } from "@playwright/test";
import type { Prisma } from "../src/generated/prisma/client";
import { variantOptionSignature } from "../src/lib/catalog/option-signature";
import { getDb } from "../src/lib/db/client";
import { requireLocalDatabase } from "../src/lib/db/local";
import { storeShop } from "../src/lib/marketplace/constants";

const image = { imageSrc: "/catalog/phone-stand.webp", imageAlt: "Search capacity fixture" };

async function generateCatalog(db: ReturnType<typeof getDb>, category: string, counts: number[], markets: readonly ("bd" | "us")[], start = 0) {
  const products: Prisma.ProductCreateManyInput[] = [];
  const options: Prisma.ProductOptionCreateManyInput[] = [];
  const values: Prisma.ProductOptionValueCreateManyInput[] = [];
  const variants: Prisma.VariantCreateManyInput[] = [];
  const selections: Prisma.VariantOptionSelectionCreateManyInput[] = [];
  const identities: Prisma.MarketOfferIdentityCreateManyInput[] = [];
  const offers: Prisma.MarketOfferCreateManyInput[] = [];
  const addedOn = new Date("2026-11-20T00:00:00Z");
  for (const [index, count] of counts.entries()) {
    const position = index + start;
    const productId = `${category}-p${String(position + 1).padStart(4, "0")}`;
    products.push({ id: productId, slug: productId, departmentId: category, foundation: true, publication: "ACTIVE",
      name: `Workbench fixture ${position + 1}`, brand: position % 2 ? "Fixture Workshop" : "Fixture Benchtop",
      description: "Synthetic compact stand with listed fit sizes", specifications: [], keywords: ["workbench"], addedOn, position });
    options.push({ productId, id: "size", key: "size", label: "Size", position: 0 });
    for (let size = 0; size < count; size++) {
      const value = `size-${size + 1}`;
      const variantId = `v-${productId}-${value}`;
      const label = `Size ${size + 1}`;
      values.push({ productId, optionId: "size", id: value, value, label, position: size });
      variants.push({ id: variantId, productId, sku: variantId.toUpperCase(), options: { size: value }, label, position: size,
        optionSignature: variantOptionSignature({ size: value }), isDefault: size === 0, managedInventory: true });
      selections.push({ variantId, productId, optionId: "size", optionValueId: value });
      for (const marketId of markets) {
        const offerId = randomUUID();
        identities.push({ id: offerId, variantId, marketId, sellerId: storeShop.id });
        offers.push({ offerId, variantId, marketId, publication: "ACTIVE", eligible: true,
          currency: marketId === "bd" ? "BDT" : "USD", amountMinor: marketId === "bd" ? 129900 + position * 100 + size : 2499 + position + size });
      }
    }
  }
  await db.$transaction(async tx => {
    await tx.product.createMany({ data: products });
    await tx.productOption.createMany({ data: options });
    await tx.productOptionValue.createMany({ data: values });
    await tx.variant.createMany({ data: variants });
    await tx.variantOptionSelection.createMany({ data: selections });
    await tx.marketOfferIdentity.createMany({ data: identities });
    await tx.marketOffer.createMany({ data: offers });
  }, { timeout: 30_000 });
  return { products, variants };
}

function distribution(samples: number[]) {
  const ordered = [...samples].sort((a, b) => a - b);
  const percentile = (value: number) => Math.round(ordered[Math.ceil(ordered.length * value) - 1]);
  return { samples: samples.length, minMs: percentile(0.01), medianMs: percentile(0.5), p95Ms: percentile(0.95), maxMs: percentile(1) };
}

test("catalog search preserves exact results and fails closed beyond 4,000 market candidates", async ({ request, baseURL }, info) => {
  test.skip(process.env.GRIIP_CATALOG_SEARCH_CAPACITY !== "1", "Use the disposable search capacity fixture.");
  requireLocalDatabase("griipbuddy_test");
  if (!baseURL || new URL(baseURL).hostname !== "127.0.0.1" || process.env.BETTER_AUTH_URL !== new URL(baseURL).origin) {
    throw new Error("Search capacity verification requires a loopback runtime backed by the test fixture.");
  }
  test.setTimeout(120_000);
  const db = getDb();
  const key = `search-capacity-${randomUUID().slice(0, 8)}`;
  const root = `${key}-department`;
  const branch = `${key}-category`;
  const scale = `${key}-scale`;
  const boundary = `${key}-boundary`;
  const route = (path: string, query: Record<string, string>) => `${path}?${new URLSearchParams(query)}`;
  const search = (query: Record<string, string>) => route("/api/catalog/search", query);
  const params = { category: scale, market: "bd", q: "Workbench", limit: "48", sort: "name" };
  const timed = async (path: string, status = 200) => {
    const started = performance.now();
    const response = await request.get(path, { maxRedirects: 0 });
    const body = await response.json();
    const elapsedMs = performance.now() - started;
    expect(response.status(), path).toBe(status);
    expect(response.headers()["cache-control"]).toMatch(/no-store/);
    return { body, elapsedMs };
  };
  try {
    for (const [id, parentId, kind] of [[root, null, "DEPARTMENT"], [branch, root, "CATEGORY"],
      [scale, branch, "SUBCATEGORY"], [boundary, branch, "SUBCATEGORY"]] as const) {
      await db.department.create({ data: { id, slug: id, name: id, shortName: id, description: "Synthetic scope", parentId, kind,
        position: 100, ...image } });
    }
    const { products, variants } = await generateCatalog(db, scale, Array.from({ length: 214 }, (_, i) => i < 141 ? 3 : 2), ["bd", "us"]);
    expect(products).toHaveLength(214);
    expect(variants).toHaveLength(569);
    const ids: string[] = [];
    let cursor: string | null = "";
    do {
      const { body } = await timed(search({ ...params, ...(cursor && { cursor }) }));
      expect(body).toMatchObject({ categoryId: scale, total: 214, marketId: "bd", currency: "BDT" });
      expect(body.facets.brand).toEqual(expect.arrayContaining([
        expect.objectContaining({ label: "Fixture Benchtop", count: 107 }), expect.objectContaining({ label: "Fixture Workshop", count: 107 }),
      ]));
      ids.push(...body.items.map((item: { id: string }) => item.id));
      expect(ids.length).toBeLessThanOrEqual(products.length);
      cursor = body.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(214);
    expect([...new Set(ids)].sort()).toEqual(products.map(({ id }) => id).sort());

    const last = variants.at(-1)!;
    const exact = (market: string) => search({ category: scale, market, q: last.sku });
    for (const [market, currency, amountMinor] of [["bd", "BDT", 151201], ["us", "USD", 2713]] as const) {
      const { body } = await timed(exact(market));
      expect(body).toMatchObject({ total: 1, items: [{ id: last.productId, matchedVariantId: last.id,
        representative: { offer: { currency, amountMinor } } }] });
    }
    const measurements: Record<string, ReturnType<typeof distribution>> = {};
    for (const [label, path] of [["BD 214 grouped product search", search(params)], ["BD exact SKU search", exact("bd")],
      ["US exact SKU search", exact("us")]]) {
      for (let warmup = 0; warmup < 3; warmup++) await timed(path);
      const samples: number[] = [];
      for (let sample = 0; sample < 20; sample++) samples.push((await timed(path)).elapsedMs);
      measurements[label] = distribution(samples);
    }

    const atLimit = await generateCatalog(db, boundary, Array.from({ length: 400 }, () => 10), ["bd"]);
    expect(atLimit.variants).toHaveLength(4000);
    const lastAtLimit = atLimit.variants.at(-1)!;
    const boundarySearch = search({ category: boundary, market: "bd", q: lastAtLimit.sku });
    const allowed = await timed(boundarySearch);
    expect(allowed.body).toMatchObject({ total: 1, items: [{ id: lastAtLimit.productId, matchedVariantId: lastAtLimit.id }] });
    await generateCatalog(db, boundary, [1], ["bd"], 400);
    const blocked = await timed(boundarySearch, 422);
    expect(blocked.body).toEqual({ error: { code: "catalog_scope_too_broad", message: expect.stringContaining("narrower") } });
    for (const path of [route("/api/catalog/products", { category: boundary, market: "bd" }),
      route("/api/marketplace/suggest", { q: last.sku, market: "bd" })]) {
      expect((await timed(path, 422)).body).toEqual(blocked.body);
    }
    expect((await timed(exact("bd"))).body).toMatchObject({ total: 1, items: [{ matchedVariantId: last.id }] });
    expect((await timed(exact("us"))).body).toMatchObject({ total: 1, items: [{ matchedVariantId: last.id }] });
    const report = { syntheticProducts: 214, syntheticVariantsPerMarket: 569, measurements,
      boundary: { allowedCandidates: 4000, allowedSearchMs: Math.round(allowed.elapsedMs),
        blockedCandidates: 4001, errorCode: "catalog_scope_too_broad", blockedSearchMs: Math.round(blocked.elapsedMs) } };
    console.log(JSON.stringify(report));
    await info.attach("synthetic search latency", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  } finally {
    await db.$transaction(async tx => {
      const variantId = { startsWith: `v-${key}-` };
      await tx.marketOffer.deleteMany({ where: { variantId } });
      await tx.marketOfferIdentity.deleteMany({ where: { variantId } });
      await tx.variant.deleteMany({ where: { id: variantId } });
      await tx.product.deleteMany({ where: { departmentId: { in: [scale, boundary] } } });
      await tx.department.deleteMany({ where: { id: { in: [scale, boundary] } } });
      await tx.department.deleteMany({ where: { id: branch } });
      await tx.department.deleteMany({ where: { id: root } });
    }, { timeout: 30_000 });
    await db.$disconnect();
  }
});
