import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { resolveCatalogMigrationReference, resolveMigratedProductSlug } from "../catalog-migration/compatibility.ts";
import { nativeSourceSystem } from "../catalog-migration/contracts.ts";
import { getDb } from "../db/client.ts";
import { isMarketSelectable } from "../market-config.ts";
import { readStaffCatalogSearchMaintenance } from "../staff/catalog-search-maintenance.ts";
import { catalogImage, productIdField, textField } from "../staff/catalog-input.ts";
import { uploadLimit } from "../staff/catalog-media.ts";
import { productMediaUploadAvailable } from "../staff/catalog-media-upload.ts";
import { mainAdminOrderReads, readMainAdminOrders } from "../staff/main-admin-orders.ts";
import { readApprovedDevice, searchApprovedDevices } from "../staff/device-fitment.ts";
import { staffDispatchLocations } from "../staff/location-inventory.ts";
import { staffMarketIds } from "../staff/market-access.ts";
import { loadCollectionWorkspace, loadNavigationWorkspace, searchCollectionProducts } from "../staff/navigation-workspace.ts";
import { CatalogWriteError } from "../staff/operation-error.ts";
import { ownerProductFoundation } from "../staff/product-foundation.ts";
import { productPublicationReadiness } from "../staff/product-publication.ts";
import { listProductWorkspace, productCategoryChoices, productWorkspaceHistory, productWorkspaceIdentity } from "../staff/product-workspace.ts";
import { readProductWorkspaceCommerce } from "../staff/product-workspace-commerce.ts";
import { categoryAssignmentProducts } from "../staff/taxonomy-assignment-read.ts";
import { categoryAttributeWorkspace, previewCategoryAttributeImpact } from "../staff/taxonomy-attribute-read.ts";
import { readCategoryImpact } from "../staff/taxonomy-impact.ts";
import { readCategoryBusinessCodes, resolveRecoveredCategoryId } from "./category-reference.ts";

const pageInput = z.int().min(1).max(10_000).optional();
const searchInput = textField(0, 120).optional();
export const mainAdminReadInput = z.discriminatedUnion("read", [
  ...mainAdminOrderReads,
  z.strictObject({
    read: z.literal("categories"), id: textField(1, 120).optional(), q: searchInput, page: pageInput,
    scope: z.enum(["direct", "descendants", "all", "search"]).optional(),
    menuKey: textField(0, 120).optional(), locale: textField(0, 35).optional(), collectionId: productIdField.optional(),
  }),
  z.strictObject({ read: z.literal("products"), q: searchInput, page: pageInput,
    state: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional(), source: z.enum(["connected", "legacy"]).optional() }),
  z.strictObject({ read: z.literal("product"), id: textField(1, 120) }),
  z.strictObject({ read: z.literal("inventory"), id: textField(1, 120).optional(), q: searchInput, page: pageInput }),
  z.strictObject({ read: z.literal("warehouses") }),
  z.strictObject({ read: z.literal("devices"), id: z.string().max(80).optional(), q: textField(0, 100).optional() }),
  z.strictObject({ read: z.literal("device"), id: productIdField }),
  z.strictObject({ read: z.literal("search-status") }),
  z.strictObject({ read: z.literal("asset"), id: catalogImage.shape.src }),
  z.strictObject({ read: z.literal("category-impact"), id: productIdField }),
  z.strictObject({ read: z.literal("attribute-impact"), input: z.record(z.string(), z.unknown()), page: pageInput }),
  z.strictObject({ read: z.literal("collection-products"), id: productIdField, q: searchInput, page: pageInput }),
]);

type Read = z.infer<typeof mainAdminReadInput>;

export function mainAdminReadPermission(read: Read["read"]) {
  if (read === "orders" || read === "order") return "operations";
  if (read === "categories") return "merchandising";
  if (read === "product" || read === "products" || read === "inventory") return "commercial";
  return "owner";
}

async function taxonomy(actorId: string, owner: boolean, marketId: MarketId, request: Extract<Read, { read: "categories" }>) {
  const db = getDb();
  const [rows, navigation, collections, permittedMarkets] = await Promise.all([
    db.department.findMany({ include: {
      translations: { orderBy: { locale: "asc" } },
      marketPresentations: { where: { marketId } },
      slugAliases: { orderBy: [{ locale: "asc" }, { slug: "asc" }] },
    }, orderBy: [{ position: "asc" }, { id: "asc" }] }),
    loadNavigationWorkspace(actorId, marketId, request.menuKey, request.locale),
    loadCollectionWorkspace(actorId, marketId, request.collectionId),
    staffMarketIds(actorId, "merchandising"),
  ]);
  const categories = rows.map(({ slugAliases, ...row }) => ({ ...row, aliases: slugAliases }));
  const reference = request.id;
  let selectedId = reference ? rows.find(row => row.id === reference)?.id ?? await resolveRecoveredCategoryId(reference, db) ??
    rows.find(row => row.slug === reference)?.id : undefined;
  if (reference && !selectedId) {
    const aliases = rows.filter(row => row.slugAliases.some(alias => alias.slug === reference) ||
      row.translations.some(translation => translation.slug === reference));
    if (aliases.length === 1) selectedId = aliases[0].id;
  }
  const categoryId = owner && rows.find(row => row.id === selectedId)?.id;
  const [attributes, assignments, businessCodes, history] = categoryId ? await Promise.all([
    categoryAttributeWorkspace(actorId, { categoryId }),
    categoryAssignmentProducts(actorId, { categoryId, q: request.q, scope: request.scope, page: request.page?.toString() }),
    readCategoryBusinessCodes(categoryId, db),
    db.auditEvent.findMany({ where: { target: categoryId, action: "TAXONOMY_SAVED" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20,
      select: { id: true, action: true, createdAt: true, changes: true, actor: { select: { name: true } } },
    }),
  ]) : [null, null, [], []];
  return { categories, navigation, collections, attributes, assignments, businessCodes, history,
    uploadEnabled: owner && productMediaUploadAvailable(),
    selectedId: rows.some(row => row.id === selectedId) ? selectedId : null, owner, markets: permittedMarkets.filter(isMarketSelectable) };
}

async function findProduct(actorId: string, id: string) {
  const db = getDb();
  // A recovered Mongo product ID resolves only against its explicit source namespace.
  const recovered = /^[a-f0-9]{24}$/.test(id) ? await resolveCatalogMigrationReference({
    sourceSystem: "recovered-mongo", entity: "product", sourceId: id,
  }, db) : null;
  const nativeId = productIdField.safeParse(id).data;
  const native = !recovered && nativeId ? await resolveCatalogMigrationReference({
    sourceSystem: nativeSourceSystem, entity: "product", sourceId: nativeId,
  }, db) : null;
  const mapped = recovered ?? native ?? await resolveMigratedProductSlug(id, db);
  const selectedId = mapped?.id;
  const product = selectedId ? await productWorkspaceIdentity(actorId, selectedId) : null;
  if (!product) throw new CatalogWriteError("not_found", "This catalog product is unavailable.");
  return product;
}

async function productWorkspace(actorId: string, owner: boolean, marketId: MarketId, id: string) {
  const identity = id === "new" ? null : await findProduct(actorId, id);
  if (!identity && !owner) throw new CatalogWriteError("forbidden", "Central owner access is required to create a shared product.");
  const product = identity?.product;
  const [shared, categories, readiness, commerce] = await Promise.all([
    owner && product?.foundation ? ownerProductFoundation(actorId, product.id) : null,
    owner ? productCategoryChoices(actorId) : [],
    owner && product?.foundation ? productPublicationReadiness(getDb(), product.id) : null,
    product?.foundation ? readProductWorkspaceCommerce({ kind: "staff", id: actorId }, product.id, marketId) : null,
  ]);
  const history = shared ? await productWorkspaceHistory(actorId, shared.id, shared.variants.map(variant => variant.id)) : [];
  return { identity, shared, categories, readiness, commerce: commerce?.data ?? null, history,
    uploadEnabled: owner && productMediaUploadAvailable() };
}

async function inventory(actorId: string, owner: boolean, marketId: MarketId, request: Extract<Read, { read: "inventory" }>) {
  if (request.id) {
    const { product } = await findProduct(actorId, request.id);
    const workspace = await readProductWorkspaceCommerce({ kind: "staff", id: actorId }, product.id, marketId);
    if (!workspace?.data) throw new CatalogWriteError("not_found", "Connected inventory for this product is unavailable.");
    return workspace.data;
  }
  const marketIds = (await staffMarketIds(actorId, "commercial")).filter(isMarketSelectable);
  const text = request.q ? { contains: request.q, mode: "insensitive" as const } : undefined;
  const pageSize = 30;
  const rows = await getDb().inventoryPool.findMany({ where: {
    variant: { product: { foundation: true }, ...(text && { OR: [
      { sku: text }, { label: text }, { product: { name: text } }, { productId: text },
    ] }) },
    location: {
      OR: [{ marketId }, { marketServices: { some: { marketId, active: true } } }],
      ...(!owner && { marketId: { in: marketIds },
        marketServices: { none: { active: true, marketId: { notIn: marketIds } } } }),
    },
  }, orderBy: [{ variantId: "asc" }, { locationId: "asc" }, { ownerId: "asc" }, { id: "asc" }],
  skip: ((request.page ?? 1) - 1) * pageSize, take: pageSize + 1, select: {
    id: true, variantId: true, ownerId: true, onHand: true, reserved: true, updatedAt: true,
    owner: { select: { name: true } }, location: { select: { id: true, name: true } },
    variant: { select: { sku: true, label: true, product: { select: { id: true, name: true } } } },
  } });
  return { rows: rows.slice(0, pageSize).map(({ owner, location, variant, ...row }) => ({
    ...row, ownerName: owner.name, warehouseId: location.id, warehouseName: location.name,
    sku: variant.sku, variantLabel: variant.label, productId: variant.product.id, productName: variant.product.name,
    available: row.onHand - row.reserved,
  })), hasNext: rows.length > pageSize };
}

export async function readMainAdminAsset(src: string) {
  let bytes: Buffer | null = null;
  if (src.startsWith("/media/")) {
    const stored = await getDb().catalogMedia.findUnique({ where: { id: src.slice(7) }, select: { data: true } });
    if (stored) bytes = Buffer.from(stored.data);
  } else {
    try { bytes = await readFile(join(process.cwd(), "public", src.slice(1))); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  if (!bytes || bytes.byteLength > uploadLimit) throw new CatalogWriteError("not_found", "This catalog image is unavailable.");
  return { contentType: "image/webp", data: bytes.toString("base64") };
}

export function readMainAdminCatalog(actorId: string, owner: boolean, marketId: MarketId, request: Read) {
  switch (request.read) {
    case "orders":
    case "order":
    case "order-cases":
    case "order-case": return readMainAdminOrders(actorId, owner, marketId, request);
    case "categories": return taxonomy(actorId, owner, marketId, request);
    case "products": return listProductWorkspace(actorId, {
      q: request.q, page: request.page ?? 1, state: request.state, source: request.source, excludeRedirected: true,
      ...(!owner && { market: marketId }),
    });
    case "product": return productWorkspace(actorId, owner, marketId, request.id);
    case "inventory": return inventory(actorId, owner, marketId, request);
    case "warehouses": return staffDispatchLocations(actorId, marketId);
    case "devices": return searchApprovedDevices(actorId, { q: request.q, variantId: request.id });
    case "device": return readApprovedDevice(actorId, request.id);
    case "search-status": return readStaffCatalogSearchMaintenance(actorId, marketId);
    case "asset": return readMainAdminAsset(request.id);
    case "category-impact": return readCategoryImpact(actorId, request.id);
    case "attribute-impact": return previewCategoryAttributeImpact(actorId, request.input, request.page ?? 1);
    case "collection-products": return searchCollectionProducts(actorId, {
      collectionId: request.id, marketId, q: request.q, page: request.page?.toString(),
    });
  }
}
