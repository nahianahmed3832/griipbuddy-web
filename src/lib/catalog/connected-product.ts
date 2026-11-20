import { markets } from "../../config/markets.ts";
import { validVariantId } from "../cart/model.ts";
import { resolveCatalogMigrationReference, resolveMigratedProductSlug } from "../catalog-migration/compatibility.ts";
import { nativeSourceSystem } from "../catalog-migration/contracts.ts";
import { integratedCheckout } from "../commerce/integrated-checkout.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { isMarketSelectable } from "../market-config.ts";
import { productIdField, slugField } from "../staff/catalog-input.ts";
import { categoryAttributes } from "./category-attributes.ts";
import { resolveConnectedCategory } from "./connected-navigation.ts";
import {
  catalogProduct, catalogVariantInclude, catalogVariants, catalogVariantWhere, CatalogApiError, type CatalogReadContext,
} from "./connected-public.ts";

const maxDetailVariants = 200;

async function productId(ref: string, db: DbReader) {
  if (productIdField.safeParse(ref).data !== ref && slugField.safeParse(ref).data !== ref) {
    throw new CatalogApiError(400, "invalid_product", "Supply a product ID or slug.");
  }
  const alias = await resolveMigratedProductSlug(ref, db);
  if (alias) return alias.id;
  const native = await resolveCatalogMigrationReference({ sourceSystem: nativeSourceSystem, entity: "product", sourceId: ref }, db);
  return native?.id ?? (await db.product.findUnique({ where: { slug: ref }, select: { id: true } }))?.id;
}

export function productSelection(params: URLSearchParams) {
  const values = params.getAll("variant");
  if ([...params.keys()].some(key => key !== "variant")) {
    throw new CatalogApiError(400, "invalid_query", "Use the variant parameter to request a selection.");
  }
  if (values.length > 1 || (values.length && !validVariantId(values[0]))) {
    throw new CatalogApiError(400, "invalid_variant", "Supply one valid variant ID.");
  }
  return values[0];
}

export async function getConnectedProduct(ref: string, context: CatalogReadContext, variantId?: string, database = getDb(), now = new Date()) {
  if (!isMarketSelectable(context.marketId)) return null;
  if (variantId !== undefined && !validVariantId(variantId)) {
    throw new CatalogApiError(400, "invalid_variant", "Supply a valid variant ID.");
  }
  return database.$transaction(async db => {
    const id = await productId(ref, db);
    if (!id) return null;
    const rows = await db.variant.findMany({
      where: { ...catalogVariantWhere(context.marketId), productId: id },
      orderBy: [{ position: "asc" }, { id: "asc" }], include: catalogVariantInclude(context), take: maxDetailVariants + 1,
    });
    if (rows.length > maxDetailVariants) throw new CatalogApiError(503, "product_variant_limit", "This product has too many options to display.");
    const parent = rows[0]?.product;
    if (!parent) return null;
    const [variants, placement, attributes] = await Promise.all([
      catalogVariants(rows, context, db, now),
      resolveConnectedCategory(parent.departmentId, context.marketId, context.locale, db),
      categoryAttributes(parent.departmentId, db),
    ]);
    if (!variants.length) return null;
    const values = new Set(variants.flatMap(variant => variant.options.flatMap(option =>
      option.valueId && option.optionId ? [JSON.stringify([option.optionId, option.valueId])] : [])));
    const options = parent.optionDefinitions.map(option => ({ ...option,
      values: option.values.filter(value => values.has(JSON.stringify([option.id, value.id]))),
    })).filter(option => option.values.length);
    const selected = variantId ? variants.find(variant => variant.id === variantId) : undefined;
    return {
      marketId: context.marketId, locale: context.locale, currency: markets[context.marketId].currency, product: catalogProduct(parent, context),
      primaryBreadcrumb: placement ? [...placement.ancestors, placement.category].map(({ id, slug, localizedSlug, name }) =>
        ({ id, slug, localizedSlug, name })) : [],
      attributes: attributes.map(({ id, name, scope }) => ({ id, name, scope })),
      personalization: parent.personalizationPrompt && !integratedCheckout(context.marketId)
        ? { prompt: parent.personalizationPrompt, required: parent.personalizationRequired } : undefined,
      options, variants, defaultVariantId: (variants.find(variant => variant.isDefault) ?? variants[0]).id,
      selection: { status: variantId === undefined ? "not_requested" as const : selected ? "matched" as const : "unavailable" as const,
        requestedVariantId: variantId ?? null, variantId: selected?.id ?? null },
    };
  }, { isolationLevel: "RepeatableRead" });
}

export async function getExactConnectedVariant(ref: string, variantId: string, context: CatalogReadContext, database = getDb(), now = new Date()) {
  if (!validVariantId(variantId)) throw new CatalogApiError(400, "invalid_variant", "Supply a valid variant ID.");
  if (!isMarketSelectable(context.marketId)) return null;
  return database.$transaction(async db => {
    const id = await productId(ref, db);
    if (!id) return null;
    const row = await db.variant.findFirst({ where: { ...catalogVariantWhere(context.marketId), id: variantId, productId: id },
      include: catalogVariantInclude(context) });
    if (!row) return null;
    const [variant] = await catalogVariants([row], context, db, now, { includeQuantityLimit: true });
    return variant && { marketId: context.marketId, locale: context.locale, currency: markets[context.marketId].currency,
      product: { id: row.product.id, slug: row.product.slug }, variant };
  }, { isolationLevel: "RepeatableRead" });
}
