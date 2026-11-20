import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { localizedStorePath } from "../../config/regional-path.ts";
import { storefrontPath } from "../../config/storefront-path.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { catalogLocaleChain, listCategoryPresentation } from "../catalog/category-presentation.ts";
import { connectedCollectionProductFilter, orderedCollectionProducts, publicCollectionScope } from "../catalog/collection-selection.ts";
import { catalogVariantWhere } from "../catalog/connected-public.ts";
import { marketMenuPages } from "../catalog/navigation.ts";
import { getDb } from "../db/client.ts";
import { isMarketSelectable, marketConfiguration, marketIdInput, marketLanguage } from "../market-config.ts";
import { hybridDemoMode } from "../release-config.ts";
import { productIdField, slugField } from "./catalog-input.ts";
import { canUseMarket } from "./market-access.ts";
import type { EditableMarketMenuItem } from "./navigation.ts";
import { authorize } from "./operations.ts";
import { CatalogWriteError, catalogWriteInput } from "./operation-error.ts";

function previewHref(path: string, marketId: MarketId, locale: string) {
  const href = hybridDemoMode() ? localizedStorePath(path, marketId) : path;
  return storefrontPath(`${href}?${new URLSearchParams({ market: marketId, lang: locale })}`);
}

async function requireWorkspace(actorId: string, marketId: MarketId) {
  const db = getDb();
  const staff = await authorize(db, actorId);
  if (!isMarketSelectable(marketId) || !await canUseMarket(actorId, marketId, "merchandising", db)) {
    throw new CatalogWriteError("forbidden", "You do not have permission to manage this market.");
  }
  return { db, owner: staff.role === "OWNER" };
}

export async function loadNavigationWorkspace(actorId: string, marketId: MarketId, requestedKey = "main", requestedLocale = "") {
  const { db } = await requireWorkspace(actorId, marketId);
  const config = marketConfiguration(marketId);
  const key = slugField.safeParse(requestedKey).data ?? "main";
  const locale = marketLanguage(config, requestedLocale) ?? "";
  const previewLocale = locale || config.defaultLocale;
  const localeChain = locale ? [...new Set([...catalogLocaleChain(locale), ""])] : [""];
  const [saved, keys, categories, collections] = await Promise.all([
    db.marketMenu.findMany({ where: { marketId, key, locale: { in: localeChain } }, select: {
      locale: true, revision: true, items: { orderBy: { position: "asc" }, select: {
        departmentId: true, collectionId: true, page: true, visible: true, label: true,
      } },
    } }),
    db.marketMenu.findMany({ where: { marketId }, distinct: ["key"], select: { key: true }, orderBy: { key: "asc" } }),
    listCategoryPresentation(marketId, previewLocale, db),
    db.collection.findMany({ where: publicCollectionScope(marketId), select: { id: true, name: true, slug: true },
      orderBy: [{ position: "asc" }, { name: "asc" }, { id: "asc" }] }),
  ]);
  const exact = saved.find(row => row.locale === locale);
  const inherited = localeChain.map(candidate => saved.find(row => row.locale === candidate)).find(row => row !== undefined);
  const items = (exact ?? inherited)?.items.flatMap<EditableMarketMenuItem>(({ departmentId, collectionId, page, label, visible }) => {
    if (departmentId) return [{ type: "category", categoryId: departmentId, label, visible }];
    if (collectionId) return [{ type: "collection", collectionId, label, visible }];
    return page ? [{ type: "page", page, label, visible }] : [];
  }) ?? [];
  return {
    marketId, marketName: config.name, locale, previewLocale, languages: config.languages, key,
    existingKeys: [...new Set(["main", ...keys.map(row => row.key)])],
    revision: exact?.revision ?? null, inheritsMenu: !exact && Boolean(inherited), items,
    categories: categories.map(category => ({ id: category.id, label: category.shortName, visible: category.visibleInNavigation,
      href: previewHref(`/departments/${encodeURIComponent(category.slug)}`, marketId, previewLocale) })),
    collections: collections.map(collection => ({ id: collection.id, label: collection.name, visible: true,
      href: previewHref(`/collections/${encodeURIComponent(collection.slug)}`, marketId, previewLocale) })),
    pages: marketMenuPages(previewLocale).map(page => ({ ...page, visible: true, href: previewHref(page.href, marketId, previewLocale) })),
  };
}

export type NavigationWorkspaceData = Awaited<ReturnType<typeof loadNavigationWorkspace>>;

function collectionProductSelect(marketId: MarketId) {
  return { id: true, name: true, publication: true,
    variants: { where: catalogVariantWhere(marketId), take: 1, select: { id: true } },
  } as const satisfies Prisma.ProductSelect;
}

type CollectionProductRow = Prisma.ProductGetPayload<{ select: ReturnType<typeof collectionProductSelect> }>;
function collectionProductView({ id, name, publication, variants }: CollectionProductRow) {
  return { id, name, publication, visibleInMarket: variants.length > 0 };
}
export type CollectionProductOption = ReturnType<typeof collectionProductView>;

export async function loadCollectionWorkspace(actorId: string, marketId: MarketId, requested?: string) {
  const { db, owner } = await requireWorkspace(actorId, marketId);
  const collectionSelect = { id: true, name: true, selection: true, defaultPublished: true,
    marketPublications: { where: { marketId }, select: { published: true } },
  } as const satisfies Prisma.CollectionSelect;
  const choices = await db.collection.findMany({ select: collectionSelect,
    orderBy: [{ position: "asc" }, { name: "asc" }, { id: "asc" }] });
  const activeId = requested === "new" && owner ? undefined :
    choices.find(row => row.id === requested)?.id ?? choices[0]?.id;
  const current = activeId ? await db.collection.findUnique({ where: { id: activeId }, select: {
    ...collectionSelect, slug: true, description: true, position: true, revision: true, imageSrc: true, imageAlt: true,
  } }) : null;
  const [eligibleCount, members] = current ? await Promise.all([
    db.product.count({ where: { ...connectedCollectionProductFilter(current), variants: { some: catalogVariantWhere(marketId) } } }),
    owner && current.selection === "CURATED" ? db.collectionProduct.findMany({ where: { collectionId: current.id },
      orderBy: orderedCollectionProducts, select: { product: { select: collectionProductSelect(marketId) } } }) : [],
  ]) : [0, []];
  const market = marketConfiguration(marketId);
  return {
    owner, marketId, marketName: market.name, eligibleCount,
    collections: choices.map(({ id, name, selection, defaultPublished, marketPublications }) => ({
      id, name, selection, published: marketPublications[0]?.published ?? defaultPublished,
    })),
    current: current && {
      id: current.id, slug: current.slug, name: current.name, description: current.description, position: current.position,
      revision: current.revision, selection: current.selection, imageSrc: current.imageSrc, imageAlt: current.imageAlt,
      published: current.marketPublications[0]?.published ?? current.defaultPublished,
      hasOverride: current.marketPublications.length > 0,
      products: members.map(({ product }) => collectionProductView(product)),
      previewHref: previewHref(`/collections/${encodeURIComponent(current.slug)}`, marketId, market.defaultLocale),
    },
  };
}

export type CollectionWorkspaceData = Awaited<ReturnType<typeof loadCollectionWorkspace>>;

const productSearchInput = z.strictObject({
  collectionId: productIdField,
  marketId: marketIdInput,
  q: z.string().trim().max(120).default(""),
  page: z.string().regex(/^[1-9][0-9]{0,3}$/).transform(Number).default(1),
});
const pageSize = 20;

export async function searchCollectionProducts(actorId: string, raw: unknown) {
  const db = getDb();
  await authorize(db, actorId, true);
  const { collectionId, marketId, q, page } = catalogWriteInput(productSearchInput, raw);
  if (!isMarketSelectable(marketId)) throw new CatalogWriteError("invalid_input", "Choose a browsable market.");
  return db.$transaction(async tx => {
    const collection = await tx.collection.findUnique({ where: { id: collectionId }, select: { selection: true } });
    if (!collection) throw new CatalogWriteError("not_found", "The collection does not exist.");
    if (collection.selection !== "CURATED") throw new CatalogWriteError("invalid_input", "Rule-based collections use existing product flags.");
    const text = { contains: q, mode: "insensitive" } as const;
    const where = {
      ...(q && { OR: [{ name: text }, { id: text }, { brand: text }, { variants: { some: { sku: text } } }] }),
      publication: { not: "ARCHIVED" },
    } satisfies Prisma.ProductWhereInput;
    const [rows, total] = await Promise.all([
      tx.product.findMany({ where, select: collectionProductSelect(marketId), orderBy: [{ name: "asc" }, { id: "asc" }],
        skip: (page - 1) * pageSize, take: pageSize }),
      tx.product.count({ where }),
    ]);
    return { products: rows.map(collectionProductView), count: total, page, pages: Math.max(1, Math.ceil(total / pageSize)) };
  }, { isolationLevel: "RepeatableRead" });
}
